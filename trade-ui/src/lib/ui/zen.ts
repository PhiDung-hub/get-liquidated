import { MediaQuery } from 'svelte/reactivity';
import { persist, settings, type ZenOpen } from '$lib/settings/settings.svelte';
import { session } from '$lib/session/session.svelte';
import { ui } from './state.svelte';

const mobile = new MediaQuery('max-width: 900px');
export const inZen = () => !mobile.current && settings.display.zen && !!session.master;

export function setZen(on: boolean) {
  if (on && mobile.current) return;
  if (on && !session.master) throw new Error('connect a wallet first');
  settings.display.zen = on;
  persist();
}

export function toggleZenPart(part: keyof ZenOpen) {
  if (!inZen()) throw new Error('zen mode only (F8)');
  settings.display.zenOpen[part] = !settings.display.zenOpen[part];
  if (part === 'order' && settings.display.zenOpen.order) ui.panelTab = 'trade';
  persist();
}
