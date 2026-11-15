export type Side = 'buy' | 'sell';
export const sideOf = (isBuy: boolean): Side => (isBuy ? 'buy' : 'sell');
export interface Toast { id: number; kind: 'info' | 'error'; text: string; side?: Side; action?: { label: string; run: () => void }; key?: string; onDismiss?: () => void }
export const toasts = $state({ list: [] as Toast[] });
let next = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const dismissed = new Map<string, string>();

function drop(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  toasts.list = toasts.list.filter((x) => x.id !== id);
}

/** The cap counts timed toasts; persistent warnings take no room from a new failure and stay until dismissed or their cause clears. */
function capped(list: Toast[]) {
  const timed = list.filter((t) => timers.has(t.id));
  if (timed.length >= 4) {
    clearTimeout(timers.get(timed[0].id));
    timers.delete(timed[0].id);
    list.splice(list.indexOf(timed[0]), 1);
  }
  return list;
}

/** A `key` already shown is replaced in place, its timer re-armed. */
function push(kind: Toast['kind'], text: string, side?: Side, ms: number | null = kind === 'error' ? 8000 : 4000, action?: Toast['action'], key?: string, onDismiss?: () => void) {
  const old = key ? toasts.list.find((t) => t.key === key) : undefined;
  const id = old?.id ?? next++;
  const t = { id, kind, text, side, action, key, onDismiss };
  toasts.list = old ? toasts.list.map((x) => (x.id === id ? t : x)) : capped([...toasts.list, t]);
  clearTimeout(timers.get(id));
  timers.delete(id);
  if (ms !== null) timers.set(id, setTimeout(() => drop(id), ms));
  return () => drop(id);
}

/** `info` covers confirmed entry fills and prompts (confirm a key, opted-in mentor advice). Other successes stay in the tables and chart. `side` colours that side's first word (buy/bid or sell/ask) in the text. */
export const toast = {
  dismiss: (id: number) => {
    const t = toasts.list.find((x) => x.id === id);
    drop(id);
    t?.onDismiss?.();
  },
  info: (t: string, side?: Side) => void push('info', t, side),
  error: (t: string, side?: Side) => void push('error', t, side),
  /** No expiry; removed by the returned function or the dismiss control. */
  sticky: (t: string) => push('info', t, undefined, null),
  /** Its button runs once and drops the toast. */
  act: (kind: Toast['kind'], t: string, label: string, run: () => void) => void push(kind, t, undefined, 8000, { label, run }),
  /** One error toast per order group, updated in place (kept while `sticky`); Dismiss holds while it stays sticky with the same `definite` failures. Once the group has no error its toast goes. */
  order: (key: string, error: string | null, side: Side, sticky = false, definite = '') => {
    if (!sticky) dismissed.delete(key);
    if (error && dismissed.get(key) === definite) return;
    if (error) return void push('error', error, side, sticky ? null : 8000, undefined, key, sticky ? () => void dismissed.set(key, definite) : undefined);
    const old = toasts.list.find((t) => t.key === key);
    if (old) drop(old.id);
  }
};
