import { SvelteMap } from 'svelte/reactivity';
import { settings } from '$lib/settings/settings.svelte';
import { isTouch } from '$lib/ui/touch';
import type { ActionDef } from './keymap';

export const armed = $state({ on: false });
let idle: ReturnType<typeof setTimeout> | undefined;

export function setArmed(on: boolean) {
  if (armed.on === on || (on && isTouch())) return;
  armed.on = on;
  if (on) touch();
  else clearTimeout(idle);
}

export function touch() {
  if (!armed.on) return;
  clearTimeout(idle);
  idle = setTimeout(() => setArmed(false), settings.idleMin * 60_000);
}

export function startArmWatch(): () => void {
  const onBlur = () => setArmed(false);
  const onHidden = () => document.hidden && setArmed(false);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onHidden);
  return () => {
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onHidden);
    setArmed(false);
  };
}

export type Barrier = 'acked' | 'read' | 'sized' | null;
export interface Queued { a: ActionDef; coin: string; user: string | null; ticket: string; barrier: Barrier; started: boolean; running: boolean }
// Per coin, in press order, until each settles.
export const queues = new SvelteMap<string, Queued[]>();
export const queued = () => queues.size > 0;

/** Esc, flatten and cancel-all forget what has not started running; nothing already sent is cancelled. */
export function clearQueued() {
  for (const [coin, q] of queues) {
    const keep = q.filter((x) => x.running);
    if (keep.length) queues.set(coin, keep);
    else queues.delete(coin);
  }
}
