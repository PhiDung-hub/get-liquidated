import type { Network } from '$lib/transport/network';

export interface LinkPayload { net: Network; master: string; agentKey: string; agentAddr: string; ts: number }

const ITERATIONS = 200_000;
const MAX_AGE_MS = 10 * 60_000;
const ADDR = /^0x[0-9a-f]{40}$/;
const KEY = /^0x[0-9a-f]{64}$/;

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const text = (b: ArrayBuffer | Uint8Array) => new TextDecoder().decode(b);
const malformed = () => new Error('malformed link');

async function pinKey(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function unseal(blob: string) {
  try {
    const s = JSON.parse(text(unb64u(blob)));
    const out = { salt: unb64u(s.salt), iv: unb64u(s.iv), ct: unb64u(s.ct) };
    if (s.v !== 1 || out.salt.length !== 16 || out.iv.length !== 12 || out.ct.length <= 16) throw malformed();
    return out;
  } catch {
    throw malformed();
  }
}

function parsePayload(plain: ArrayBuffer): LinkPayload {
  try {
    const p = JSON.parse(text(plain));
    const ok = (p.net === 'mainnet' || p.net === 'testnet') && ADDR.test(p.master) && KEY.test(p.agentKey) && ADDR.test(p.agentAddr) && Number.isFinite(p.ts);
    if (!ok) throw malformed();
    return { net: p.net, master: p.master, agentKey: p.agentKey, agentAddr: p.agentAddr, ts: p.ts };
  } catch {
    throw malformed();
  }
}

export async function sealLink(p: LinkPayload, pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await pinKey(pin, salt), new TextEncoder().encode(JSON.stringify(p)));
  return b64u(new TextEncoder().encode(JSON.stringify({ v: 1, salt: b64u(salt), iv: b64u(iv), ct: b64u(new Uint8Array(ct)) })));
}

export async function openLink(blob: string, pin: string): Promise<LinkPayload> {
  const { salt, iv, ct } = unseal(blob);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await pinKey(pin, salt), ct);
  } catch {
    throw new Error('wrong PIN');
  }
  const p = parsePayload(plain);
  if (Date.now() - p.ts > MAX_AGE_MS) throw new Error('link expired');
  return p;
}

export function linkUrl(blob: string): string {
  return `${location.origin}/#link=${blob}`;
}

/** The `#link=` blob inside a scanned or pasted link, or null when the text holds none. */
export function linkBlobOf(text: string): string | null {
  return /#link=([\w-]+)/.exec(text)?.[1] ?? null;
}

export function takeLinkFragment(): string | null {
  if (!location.hash.startsWith('#link=')) return null;
  const blob = location.hash.slice('#link='.length);
  try {
    history.replaceState(history.state, '', location.pathname + location.search);
  } catch (e) {
    console.warn('could not strip the link from the address bar', e);
  }
  return blob;
}
