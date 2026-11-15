import { ENDPOINTS, net } from './network';

export type Sub = { type: string } & Record<string, unknown>;
type Pending = { type: 'info' | 'action'; resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/** HL refused a post over its per-IP limit: REST answers 429, the socket mirrors it as '429 Too Many Requests', or too many posts are pending. */
export const rateLimited = (e: unknown) => (e as TransportError)?.kind === 'limited';

export class TransportError extends Error {
  name = 'TransportError';
  /** 'limited': refused over the IP rate limit. HL does not document that a refused action never ran, so an order refused this way stays unconfirmed. */
  constructor(public kind: 'timeout' | 'closed' | 'server' | 'http' | 'limited', message: string, public retryMs?: number) {
    super(message);
  }
}

const MAX_IN_FLIGHT = 90;
const RECONNECT_MIN_MS = 2000;
const STABLE_MS = 10_000;
const PING_MS = 5000;
const DEAD_MS = 10_000;
const WAKE_MS = 2000;
const HOLD_MIN_MS = 2000;
const HOLD_MAX_MS = 60_000;
const subKey = (s: Sub) => JSON.stringify(Object.keys(s).sort().map((k) => [k, s[k]]));
/** HL's subscribe ack echoes the subscription with every absent option filled in as null or false. */
const ackKey = (s: Sub) => subKey(Object.fromEntries(Object.entries(s).filter(([, v]) => v !== null && v !== false)) as Sub);
const FAST_BOOK_LEVELS = 5;
/** HL tags fast l2Book frames `fast: true`. An untagged frame with at most 5 levels a side also counts as fast, so a thin market's whole book reaches the top handler. */
const fastBook = (data: any): boolean => data?.fast ?? !(data?.levels ?? []).some((side: unknown[]) => side.length > FAST_BOOK_LEVELS);

/** Route a channel message to a subscription: market feeds carry the coin, user feeds carry the user. */
function matches(sub: Sub, channel: string, data: any): boolean {
  if (sub.type !== channel && !(sub.type === 'activeAssetCtx' && channel === 'activeSpotAssetCtx')) return false;
  if (sub.user !== undefined && data?.user !== undefined && String(data.user).toLowerCase() !== String(sub.user).toLowerCase()) return false;
  if (sub.coin !== undefined) {
    const coin = Array.isArray(data) ? data[0]?.coin : (data?.coin ?? data?.s);
    if (coin !== undefined && coin !== sub.coin) return false;
  }
  if (sub.type === 'l2Book' && fastBook(data) !== !!sub.fast) return false;
  return sub.interval === undefined || data?.i === undefined || data.i === sub.interval;
}

/** The socket static/boot.js opened at page load, taken once, when it is for this endpoint and not closing. */
function early(url: string): WebSocket | null {
  const ws = globalThis.window?.__hlSocket;
  if (!ws) return null;
  window.__hlSocket = undefined;
  if (ws.url === url && ws.readyState <= WebSocket.OPEN) return ws;
  ws.close();
  return null;
}

export class Socket {
  state = $state<'connecting' | 'open' | 'closed'>('closed');
  rtt = $state(0);
  reconnects = $state(0);
  /** True from an info read HL refused with a 429 until the next one it answers. */
  limited = $state(false);
  private holdUntil = 0;
  private holdMs = 0;
  private ws: WebSocket | null = null;
  private subs = new Map<string, { sub: Sub; handlers: Set<(d: any) => void>; acks: Set<() => void>; fails: Set<() => void>; unacked: boolean }>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private backoff = RECONNECT_MIN_MS;
  private openedAt = 0;
  private pingAt = 0;
  private lastMsgAt = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attemptAt = 0;
  private pongAt = 0;
  private queued: (() => void)[] = [];
  private wanted = false;
  private everOpened = false;

  constructor(private url: string, private httpBase: string) {}

  connect() {
    this.wanted = true;
    if (this.ws) return;
    this.state = 'connecting';
    this.attemptAt = performance.now();
    const ws = early(this.url) ?? new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => this.onOpen();
    ws.onmessage = (e) => this.onMessage(String(e.data));
    ws.onclose = () => this.onClose();
    ws.onerror = () => ws.close();
    if (ws.readyState === WebSocket.OPEN) this.onOpen();
  }

  close() {
    this.wanted = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.ws?.close();
  }

  /**
   * `onAck` runs on each subscribe ack from HL for this subscription, including the ones a reconnect brings.
   * `onFail` runs when HL refuses it: an error frame echoing it, or the socket closing before its ack (HL drops the whole socket on an unknown dex).
   */
  subscribe(sub: Sub, handler: (data: any) => void, onAck?: () => void, onFail?: () => void): () => void {
    const key = subKey(sub);
    let entry = this.subs.get(key);
    if (!entry) {
      entry = { sub, handlers: new Set(), acks: new Set(), fails: new Set(), unacked: this.up };
      this.subs.set(key, entry);
      this.send({ method: 'subscribe', subscription: sub });
    }
    entry.handlers.add(handler);
    if (onAck) entry.acks.add(onAck);
    if (onFail) entry.fails.add(onFail);
    return () => {
      const e = this.subs.get(key);
      if (!e) return;
      e.handlers.delete(handler);
      if (onAck) e.acks.delete(onAck);
      if (onFail) e.fails.delete(onFail);
      if (e.handlers.size) return;
      this.subs.delete(key);
      this.send({ method: 'unsubscribe', subscription: sub });
    };
  }

  /** A new subscribe answers with a snapshot at once; a held feed can wait for HL's ~5 s tick. The handlers stay, so no frame is missed. */
  refresh(sub: Sub) {
    if (!this.up || !this.subs.has(subKey(sub))) return;
    this.send({ method: 'unsubscribe', subscription: sub });
    this.send({ method: 'subscribe', subscription: sub });
  }

  /**
   * Back in view: a socket that slept can be half-open, stuck connecting or waiting out a retry, and the heartbeat alone takes up to 15 s to find out.
   * Only a pong clears an open one, as frames buffered through the sleep prove nothing; it goes after WAKE_MS of silence with no pong. HL refused nothing, so its unacked subs don't fail.
   */
  wake(): void {
    if (!this.wanted) return;
    const ws = this.ws;
    if (ws && !this.up) {
      if (performance.now() - this.attemptAt < WAKE_MS) return;
      this.drop();
      return this.wake();
    }
    if (!ws) return this.again(Math.max(0, RECONNECT_MIN_MS - (performance.now() - this.attemptAt)));
    this.ping();
    const at = this.pingAt;
    const verdict = () => {
      if (this.ws !== ws || !this.up || this.pongAt >= at) return;
      const quiet = performance.now() - this.lastMsgAt;
      if (quiet < WAKE_MS) return void setTimeout(verdict, WAKE_MS - quiet);
      for (const e of this.subs.values()) e.unacked = false;
      this.drop();
      this.wake();
    };
    setTimeout(verdict, WAKE_MS);
  }

  private again(ms: number) {
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.retry = null;
      if (this.wanted) this.connect();
    }, ms);
  }

  private get up() {
    return this.state === 'open' && this.ws?.readyState === WebSocket.OPEN;
  }

  /** Ms left of the 429 hold. */
  holdLeft = () => Math.max(0, this.holdUntil - Date.now());

  /**
   * HL weighs REST and socket posts against one per-IP budget, so any 429 (a read's or an action's) starts one hold, doubling from 2 s to 60 s or HL's Retry-After.
   * Info reads wait it out; actions and the reads an order needs (`wait` false: reconcile's cloid checks among them) never wait.
   */
  post(type: 'info' | 'action', payload: object, timeoutMs = 5000, wait = true): Promise<any> {
    if (type === 'info') {
      const held = wait ? this.holdLeft() : 0;
      return held > 0 ? new Promise((r) => setTimeout(r, held)).then(() => this.read(payload, timeoutMs)) : this.read(payload, timeoutMs);
    }
    const full = this.pending.size >= MAX_IN_FLIGHT;
    const sent = !this.up ? this.rest(type, payload, timeoutMs) : full || this.queued.length ? this.enqueue(payload, timeoutMs) : this.wsPost(type, payload, timeoutMs);
    return sent.catch(this.limit);
  }

  private read(payload: object, timeoutMs: number): Promise<any> {
    const sent = this.up && this.pending.size < MAX_IN_FLIGHT ? this.wsPost('info', payload, timeoutMs) : this.rest('info', payload, timeoutMs);
    return sent.then((v) => ((this.holdMs = 0), (this.limited = false), v), this.limit);
  }

  private limit = (e: unknown): never => {
    if (rateLimited(e)) this.hold((e as TransportError).retryMs);
    throw e;
  };

  /** A burst of 429s from one round of reads holds once. */
  private hold(hint?: number) {
    if (Date.now() < this.holdUntil) return;
    this.holdMs = hint ?? Math.min(Math.max(this.holdMs * 2, HOLD_MIN_MS), HOLD_MAX_MS);
    this.holdUntil = Date.now() + this.holdMs;
    this.limited = true;
  }

  private wsPost(type: 'info' | 'action', payload: object, timeoutMs: number): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.drain();
        reject(new TransportError('timeout', `${type} post ${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { type, resolve, reject, timer });
      this.send({ method: 'post', id, request: { type, payload } });
    });
  }

  /** Actions never overflow to REST while the socket is up (spec §1, Fast path item 1): they wait FIFO for a free slot. */
  private enqueue(payload: object, timeoutMs: number): Promise<any> {
    const until = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const go = () => {
        clearTimeout(timer);
        const left = Math.max(until - Date.now(), 1);
        const sent = this.up ? this.wsPost('action', payload, left) : this.rest('action', payload, left);
        sent.then(resolve, reject);
      };
      const timer = setTimeout(() => {
        this.queued = this.queued.filter((q) => q !== go);
        reject(new TransportError('timeout', `action waited ${timeoutMs}ms for a free post slot`));
      }, timeoutMs);
      this.queued.push(go);
    });
  }

  private drain() {
    while (this.queued.length && (this.state !== 'open' || this.pending.size < MAX_IN_FLIGHT)) this.queued.shift()!();
  }

  private async rest(type: 'info' | 'action', payload: object, timeoutMs: number) {
    const path = type === 'info' ? '/info' : '/exchange';
    let status: number;
    let text: string;
    let after: number;
    try {
      const res = await fetch(this.httpBase + path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs)
      });
      status = res.status;
      after = Number(res.headers.get('retry-after')) * 1000;
      text = await res.text();
      if (res.ok) return JSON.parse(text);
    } catch (e) {
      const kind = (e as Error).name === 'TimeoutError' ? 'timeout' : 'closed';
      throw new TransportError(kind, `${path}: ${(e as Error).message}`);
    }
    // A 429 or 5xx on /exchange doesn't prove the action was refused, so it stays unknown and reconciles; any other 4xx is refused before it runs.
    const kind = status === 429 ? 'limited' : type === 'action' && status >= 500 ? 'closed' : 'http';
    throw new TransportError(kind, `${path} ${status}: ${text.slice(0, 200)}`, after > 0 ? Math.min(after, HOLD_MAX_MS) : undefined);
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onOpen() {
    this.state = 'open';
    this.openedAt = performance.now();
    if (this.everOpened) this.reconnects++;
    this.everOpened = true;
    for (const e of this.subs.values()) {
      e.unacked = true;
      this.send({ method: 'subscribe', subscription: e.sub });
    }
    this.heartbeat = setInterval(() => this.beat(), PING_MS);
    this.ping();
  }

  private ping() {
    this.pingAt = performance.now();
    this.send({ method: 'ping' });
  }

  /** A half-open socket can stay OPEN for minutes, so no frame within DEAD_MS of a ping counts as closed; waiting for the browser's close event could stall too. */
  private beat() {
    if (this.lastMsgAt >= this.pingAt) return this.ping();
    if (performance.now() - this.pingAt >= DEAD_MS) this.drop();
  }

  private drop() {
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    this.onClose();
    ws.close();
  }

  private onClose() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.ws = null;
    this.state = 'closed';
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new TransportError('closed', `socket closed with post ${id} in flight`));
    }
    this.pending.clear();
    this.drain();
    for (const e of this.subs.values()) {
      if (!e.unacked) continue;
      e.unacked = false;
      e.fails.forEach((f) => f());
    }
    if (this.openedAt && performance.now() - this.openedAt >= STABLE_MS) this.backoff = RECONNECT_MIN_MS;
    this.openedAt = 0;
    if (!this.wanted) return;
    // HL allows 30 new connections/min: attempts are at least 2s apart, and the delay only resets after a connection stayed open 10s.
    this.again(this.backoff);
    this.backoff = Math.min(this.backoff * 2, 15_000);
  }

  private onMessage(raw: string) {
    this.lastMsgAt = performance.now();
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return void console.warn('dropped non-JSON socket frame', raw.slice(0, 200));
    }
    if (msg.channel === 'pong') return void ((this.pongAt = performance.now()), (this.rtt = Math.round(this.pongAt - this.pingAt)));
    if (msg.channel === 'post') return this.onPost(msg.data);
    if (msg.channel === 'error') return this.onChannelError(msg.data);
    if (msg.channel === 'subscriptionResponse') return this.onAck(msg.data);
    for (const { sub, handlers } of this.subs.values()) {
      if (!matches(sub, msg.channel, msg.data)) continue;
      for (const h of handlers) {
        try {
          h(msg.data);
        } catch (e) {
          console.warn(`dropped ${msg.channel} message`, e);
        }
      }
    }
  }

  private onAck(data: any) {
    if (data?.method !== 'subscribe' || !data.subscription) return;
    const key = ackKey(data.subscription);
    for (const e of this.subs.values()) {
      if (ackKey(e.sub) !== key) continue;
      e.unacked = false;
      e.acks.forEach((f) => f());
    }
  }

  /**
   * True when the error frame is about a subscription, never a post: a refused subscribe fails only its own subscription.
   * Unsubscribing one HL never held (a refused one) answers "Already unsubscribed: {subscription}".
   */
  private refused(raw: string): boolean {
    if (raw.startsWith('Already unsubscribed')) return true;
    let echo: any;
    try {
      echo = JSON.parse(raw.slice(raw.indexOf('{')));
    } catch {
      return false;
    }
    if (!echo?.subscription || (echo.method !== 'subscribe' && echo.method !== 'unsubscribe')) return false;
    if (echo.method === 'unsubscribe') return true;
    const key = ackKey(echo.subscription);
    for (const e of this.subs.values()) if (ackKey(e.sub) === key) e.fails.forEach((f) => f());
    return true;
  }

  /**
   * The server rejected the frame at parse time and echoes it, so the post never ran and can fail as final. Without a recoverable id, only pending infos fail: actions keep their own timeout and reconcile by cloid.
   * 'too many pending post requests' (HL's answer when this IP has too many posts in flight, naming the post by id=N) is a rate limit: an action it names may have run, so it stays unconfirmed.
   */
  private onChannelError(data: unknown) {
    console.warn('ws error', data);
    const raw = String(data);
    if (this.refused(raw)) return;
    const busy = /too many pending post requests/i.test(raw);
    const named = /\{"method":"post","id":(\d+)[,}]/.exec(raw) ?? (busy ? /\bid=(\d+)/.exec(raw) : null);
    const id = named ? Number(named[1]) : -1;
    const ids = this.pending.has(id) ? [id] : [...this.pending].filter(([, p]) => p.type === 'info').map(([i]) => i);
    for (const i of ids) {
      const p = this.pending.get(i)!;
      this.pending.delete(i);
      clearTimeout(p.timer);
      p.reject(new TransportError(busy ? 'limited' : 'server', raw));
    }
    this.drain();
  }

  private onPost(data: { id: number; response: { type: string; payload: any } }) {
    const p = this.pending.get(data.id);
    if (!p) return;
    this.pending.delete(data.id);
    clearTimeout(p.timer);
    this.drain();
    const { type, payload } = data.response;
    if (type !== 'error') return p.resolve(type === 'info' ? payload.data : payload);
    // Like a REST 5xx, an action's post error (a 429 too) doesn't prove it didn't execute: it reconciles by cloid.
    const kind = /\b429\b/.test(String(payload)) ? 'limited' : p.type === 'action' ? 'closed' : 'server';
    p.reject(new TransportError(kind, String(payload)));
  }
}

export const socket = new Socket(ENDPOINTS[net.current].ws, ENDPOINTS[net.current].http);
