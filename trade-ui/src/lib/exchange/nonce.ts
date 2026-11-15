import { net } from '$lib/transport/network';
import { load, save } from '$lib/util/storage';

const last = new Map<string, number>();
const keyFor = (agent: string) => `trade-ui:nonce:${net.current}:${agent}`;

/** HL keeps the 100 highest nonces per signer; strictly increasing ms timestamps never collide. */
export function nextNonce(agent: string): number {
  const prev = Math.max(last.get(agent) ?? 0, load<number>(keyFor(agent), 0));
  const n = Math.max(Date.now(), prev + 1);
  last.set(agent, n);
  // Off the send's path: saved once this task signed and sent; `last` covers a second send in the same task.
  queueMicrotask(() => save(keyFor(agent), n));
  return n;
}
