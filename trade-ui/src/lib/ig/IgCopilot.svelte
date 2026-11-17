<script lang="ts">
  import { onMount } from 'svelte';
  import { load, save } from '$lib/util/storage';
  import connector from '$lib/agent/connector.json';
  import type { AnnotationChat, IgContext, Mark, Observation } from '../../../../agent/src/wire.ts';

  let { context, marks = $bindable([]), hidden = false }: { context: () => IgContext | null; marks?: Mark[]; hidden?: boolean } = $props();
  const AGENT = `http://127.0.0.1:${import.meta.env.VITE_GETLIQ_PORT ?? '28657'}`, TOKEN = 'trade-ui:agent-token', SHARE = 'ig:share-chart';
  const SETUP = `npx --yes --package "gist:${connector.gist}#${connector.revision}" getliq setup`;
  let token = $state(''), address = $state(''), share = $state(true), busy = $state(false), note = $state(''), link = $state(''), question = $state('');
  let chats = $state<AnnotationChat[]>([]), advice = $state<Observation[]>([]), answering = $state(false);
  const coin = $derived(context()?.coin ?? '');
  const thread = $derived(chats.filter(c => c.mark.coin === coin).toSorted((a, b) => a.mark.created - b.mark.created).flatMap(c => c.messages));
  const tips = $derived(advice.filter(a => !a.coin || a.coin === coin));
  const waiting = $derived(thread.at(-1)?.role === 'user');

  const OFFLINE = 'getliq is not running on this computer, or the browser blocked local network access for this site.', OUTDATED = `Your getliq does not allow this page yet. Update it to ${connector.version}: ${SETUP}`;
  const utf8 = (value: string) => new TextEncoder().encode(value), hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  let proven = '';
  /** The program on the port must show it already holds this code or token (HMAC of a nonce keyed by its hash) before the secret is sent to it. */
  async function prove(secret: string) {
    if (proven === secret) return;
    const nonce = crypto.randomUUID();
    const response = await fetch(`${AGENT}/health?nonce=${nonce}`, { signal: AbortSignal.timeout(5000) }).catch(() => { throw new Error(OFFLINE); });
    if (response.status === 403) throw new Error(OUTDATED);
    const body = await response.json().catch(() => null);
    const key = await crypto.subtle.importKey('raw', utf8(hex(await crypto.subtle.digest('SHA-256', utf8(secret)))), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    if (body?.app !== 'getliq' || !Array.isArray(body.proofs) || !body.proofs.includes(hex(await crypto.subtle.sign('HMAC', key, utf8(nonce))))) {
      if (secret === token) forget();
      throw new Error('getliq on this computer does not know this pairing. Pair again with a new link.');
    }
    proven = secret;
  }
  async function call<T>(path: string, body: unknown = undefined, bearer = token): Promise<T> {
    const headers: Record<string, string> = { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(address ? { 'x-agent-address': address } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
    const response = await fetch(`${AGENT}/api/agent/${path}`, { method: body !== undefined ? 'POST' : 'GET', headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) })
      .catch(() => { proven = ''; throw new Error(OFFLINE); });
    const result = await response.json().catch(() => ({}));
    if (response.status === 401) { forget(); throw new Error('This browser is no longer paired. Pair again.'); }
    if (response.status === 403) throw new Error(OUTDATED);
    if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'getliq request failed');
    return result as T;
  }
  function forget() { token = ''; address = ''; marks = []; chats = []; advice = []; save(TOKEN, null); }
  async function guard(action: () => Promise<void>) {
    busy = true; note = '';
    try { await action(); } catch (e) { note = e instanceof Error ? e.message : 'getliq request failed'; } finally { busy = false; }
  }
  const pair = (value: string) => guard(async () => {
    const code = /[A-Za-z0-9_-]{43}/.exec(value.split('getliq-pair=').pop() ?? '')?.[0];
    if (!code) throw new Error('Paste the pairing link or its 43-character code.');
    await prove(code);
    const result = await call<{ token: string; address: string }>('pair', { code }, '');
    token = result.token; address = result.address; link = ''; save(TOKEN, token);
    await sync();
  });
  async function sync() {
    if (!token || document.hidden) return;
    await prove(token);
    if (!address) address = (await call<{ address: string }>('me')).address;
    const shared = share ? context() : null;
    await call('context?venue=ig', shared);
    const state = await call<{ marks: Mark[]; chats?: AnnotationChat[]; advice?: Observation[]; answerer?: { on?: boolean } }>('state');
    marks = state.marks; chats = state.chats ?? []; advice = state.advice ?? []; answering = !!state.answerer?.on;
  }
  const ask = () => guard(async () => {
    const shared = context(), message = question.trim();
    if (!shared || shared.bid === null || shared.offer === null || !shared.candles.length) throw new Error('Open a market with a current quote and chart first.');
    await prove(token);
    await call('context?venue=ig', shared);
    await call('marks', { coin: shared.coin, interval: shared.interval, type: 'level', a: (shared.bid + shared.offer) / 2, t0: shared.candles[0][0], t1: shared.candles.at(-1)![0], message });
    question = '';
    await sync();
  });
  const unpair = () => guard(async () => { await prove(token).then(() => call('logout', {})).catch(() => {}); forget(); });
  function setShare(value: boolean) { share = value; save(SHARE, value); void guard(sync); }

  onMount(() => {
    share = load(SHARE, true);
    const saved = load<unknown>(TOKEN, null);
    token = typeof saved === 'string' && /^[A-Za-z0-9_-]{43}$/.test(saved) ? saved : '';
    const hash = /#getliq-pair=([A-Za-z0-9_-]{43})/.exec(location.hash)?.[1];
    if (hash) { history.replaceState(null, '', location.pathname + location.search); void pair(hash); }
    else void guard(sync);
    let beat = 0;
    const timer = setInterval(() => { if (!busy && (waiting || ++beat % 5 === 0)) sync().catch(e => note = e instanceof Error ? e.message : ''); }, 3000);
    return () => clearInterval(timer);
  });
</script>

<div class="copilot" data-testid="ig-copilot" {hidden}>
  {#if !token}
    <p>The Co-pilot is your own Claude Code or Codex, reached through getliq on this computer. It reads this chart, your IG positions and orders from this page; it has no IG login and cannot trade.</p>
    <p>1. Install or update getliq {connector.version}:</p><code>{SETUP}</code>
    <p>2. Ask your AI for <b>pair_browser</b> and paste its link:</p>
    <form onsubmit={e => { e.preventDefault(); void pair(link); }}><input class="ui-field" aria-label="Pairing link" placeholder="Pairing link or code" bind:value={link} /><button class="ui-tab" disabled={busy || !link.trim()}>{busy ? 'Pairing…' : 'Pair'}</button></form>
  {:else}
    <div class="row"><label title="Sends the market on screen, its last 200 bars, your positions, working orders and funds to getliq on this computer every 15 seconds while this tab is visible."><input type="checkbox" checked={share} onchange={e => setShare(e.currentTarget.checked)} /> Share this chart</label><button class="ui-tab" disabled={busy} onclick={unpair}>Unpair</button></div>
    {#each tips as tip (tip.id)}<div class="tip" data-testid="ig-advice"><b>{tip.skill}</b><p>{tip.advice}</p><small>{tip.nextStep}</small></div>{/each}
    <div class="thread" data-testid="ig-thread">{#each thread as m (m.id)}<p class={m.role}>{m.text}</p>{:else}<p class="dim">Ask about {context()?.name ?? 'the market on screen'}. {answering ? 'Answers appear here.' : 'Answers appear here once your AI session reads the question (annotation_chat), or turn on answers on screen in getliq setup.'}</p>{/each}{#if waiting}<p class="dim">Waiting for your AI…</p>{/if}</div>
    <form onsubmit={e => { e.preventDefault(); void ask(); }}><input class="ui-field" aria-label="Question for the Co-pilot" placeholder="Ask about this chart" maxlength="1000" bind:value={question} disabled={!share} /><button class="ui-tab" disabled={busy || !share || !question.trim()}>Ask</button></form>
  {/if}
  {#if note}<p class="note" role="alert">{note}</p>{/if}
</div>

<style>
  .copilot { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; font-size: 12px; } .copilot[hidden] { display: none; }
  p { margin: 0; line-height: 1.5; } code { padding: 6px; background: var(--surface); font-size: 11px; overflow-wrap: anywhere; user-select: all; }
  form, .row { display: flex; gap: 6px; align-items: center; justify-content: space-between; } form input { flex: 1; min-width: 0; color: var(--text); }
  .row label { display: flex; gap: 6px; align-items: center; color: var(--dim); }
  .thread { flex: 1; min-height: 60px; overflow: auto; display: flex; flex-direction: column; gap: 8px; scrollbar-width: thin; } .thread p { white-space: pre-wrap; overflow-wrap: anywhere; }
  .user { color: var(--bright); font-weight: 500; } .assistant { color: var(--text); } .dim, small { color: var(--dim); } .note { color: var(--warn-text); }
  .tip { padding: 6px 8px; background: var(--surface); } .tip small { display: block; }
</style>
