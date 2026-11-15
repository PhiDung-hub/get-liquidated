import { socket, TransportError } from '$lib/transport/ws.svelte';
import { l1Digest } from '$lib/signing/l1';
import { signDigest, type Signature } from '$lib/signing/keys';
import type { Action } from './actions';

export interface Signer { key: Uint8Array; isMainnet: boolean; nextNonce(): number }
export type Status =
  | { resting: { oid: number; cloid?: string } }
  | { filled: { totalSz: string; avgPx: string; oid: number; cloid?: string } }
  | { error: string } | 'waitingForFill' | 'waitingForTrigger' | 'success';

const SIG_FAULT = /does not exist|must deposit/i;

export class ExchangeError extends Error {
  name = 'ExchangeError';
  possibleSigFault: boolean;
  constructor(public layer: 'transport' | 'status', public kind: 'timeout' | 'closed' | 'server' | 'http' | 'limited' | 'rejected', message: string) {
    super(message);
    this.possibleSigFault = SIG_FAULT.test(message);
  }
}

/** The action may have run: it timed out, the socket dropped with it in flight, or HL refused it over the IP rate limit. Only a cloid read or the feeds settle it. */
export const unproven = (e: unknown) => e instanceof ExchangeError && e.layer === 'transport' && (e.kind === 'timeout' || e.kind === 'closed' || e.kind === 'limited');

export const statusError = (s: Status): string | null => (typeof s === 'object' && 'error' in s ? s.error : null);

async function post(body: object, timeoutMs: number): Promise<Status[]> {
  let res: any;
  try {
    res = await socket.post('action', body, timeoutMs);
  } catch (e) {
    if (e instanceof TransportError) throw new ExchangeError('transport', e.kind, e.message);
    throw e;
  }
  if (res?.status === 'err') throw new ExchangeError('status', 'rejected', String(res.response));
  // An unrecognised body doesn't prove the action was rejected, so it reconciles like a dropped socket.
  if (res?.status !== 'ok') throw new ExchangeError('transport', 'closed', `unexpected response ${JSON.stringify(res).slice(0, 200)}`);
  const data = res.response?.data;
  // A one-off action (TWAP, as HL's own client reads it) carries a single status.
  return data?.statuses ?? (data?.status === undefined ? [] : [data.status]);
}

export function sendAction(signer: Signer, action: Action, timeoutMs = 5000): Promise<Status[]> {
  const nonce = signer.nextNonce();
  const signature = signDigest(l1Digest(action, nonce, signer.isMainnet), signer.key);
  return post({ action, nonce, signature, vaultAddress: null }, timeoutMs);
}

export const sendUserSigned = (action: { nonce: number }, signature: Signature) =>
  post({ action, nonce: action.nonce, signature, vaultAddress: null }, 10_000);
