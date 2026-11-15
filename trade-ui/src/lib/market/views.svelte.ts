import { persist, settings } from '$lib/settings/settings.svelte';
import { toast } from '$lib/ui/toast.svelte';
import { unlisted } from './meta.svelte';

export const MAX_QUICK = 5;

/** The quick-switch bar is the ★★ list alone; ★ favourites belong to the market picker and never move it. */
export const topChips = () => settings.superstars.filter((c) => !unlisted(c)).slice(0, MAX_QUICK);

const without = (list: string[], coin: string) => list.filter((c) => c !== coin);

export function removeQuick(coin: string) {
  settings.superstars = without(settings.superstars, coin);
  persist();
}

/** The bar's order becomes the ★★ list; ★★ markets not loaded yet (HIP-3, spot) follow it and keep their slots. */
function setBar(bar: string[]) {
  const hidden = settings.superstars.filter((c) => !bar.includes(c));
  if (bar.length + hidden.length > MAX_QUICK) return toast.error('Five quick-switch markets maximum, counting ★★ markets not loaded yet. Remove one first.');
  settings.superstars = [...bar, ...hidden];
  persist();
}

export function addQuick(coin: string) {
  const bar = topChips();
  if (bar.includes(coin)) return;
  if (bar.length >= MAX_QUICK) return toast.error('Five quick-switch markets maximum. Remove one first.');
  setBar([...bar, coin]);
}

export function moveQuick(from: number, to: number) {
  const bar = topChips();
  if (from < 0 || to < 0 || to >= bar.length || from === to) return;
  bar.splice(to, 0, ...bar.splice(from, 1));
  setBar(bar);
}
