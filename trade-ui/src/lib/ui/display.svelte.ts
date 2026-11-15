import { DEFAULTS, settings, validNum } from '$lib/settings/settings.svelte';

// The Display field (Task 3) binds live, so a half-typed size ("1" on the way to "16") keeps the last valid one.
let good = DEFAULTS.display.fs;
const fs = () => (good = validNum('display.fs', settings.display.fs) ? settings.display.fs : good);

export function applyDisplay(): void {
  document.documentElement.style.setProperty('--fs', fs() + 'px');
  document.documentElement.dataset.theme = settings.display.theme;
}

export const chartFont = () => Math.max(8, Math.round(fs() * 0.917));
