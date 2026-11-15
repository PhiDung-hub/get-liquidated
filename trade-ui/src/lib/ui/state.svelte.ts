
export type Modal = { kind: 'close'; coin: string; limit: boolean } | { kind: 'reverse'; coin: string } | { kind: 'trailing'; coin: string } | { kind: 'positionTpsl'; coin: string; focus: 'TP' | 'SL' } | { kind: 'isoMargin'; coin: string } | { kind: 'editOrder'; oid: number } | { kind: 'study'; id: string };
export type Overlay = null | 'interval' | 'goto' | 'picker' | 'quick' | 'compare' | 'help' | 'settings' | 'migration' | 'leverage' | 'margin' | 'link' | 'linkImport' | 'linkScan' | 'sweep' | 'aiConnect' | 'indicators' | Modal;
export type BottomTab = 'positions' | 'balances' | 'orders' | 'fills' | 'funding';
export type SettingsTab = 'execution' | 'hotkeys' | 'display' | 'data';
export const ui = $state({
  overlay: null as Overlay, chartFull: false, bottomTab: 'positions' as BottomTab, bookTab: 'book' as 'book' | 'trades',
  settingsTab: 'execution' as SettingsTab, panelTab: 'trade' as 'trade' | 'ai', intervalInput: '', marketTab: 'chart' as 'chart' | 'book' | 'trades'
});
export const ARMING = 'Just opened: confirm again in a moment.';
/** `on` turns true 350 ms after a dialog opens as a low card: the tap that opened it lands where its Confirm sits, so the second of a double tap, or a key, must not confirm. A centred dialog is live at once. Call during component init. */
export function arming() {
  const arm = $state({ on: !matchMedia('(max-width: 900px), (pointer: coarse) and (max-height: 500px)').matches });
  $effect(() => {
    const t = setTimeout(() => (arm.on = true), 350);
    return () => clearTimeout(t);
  });
  return arm;
}
export const modal = (): Modal | null => (ui.overlay !== null && typeof ui.overlay === 'object' ? ui.overlay : null);

export function openSettings(tab: SettingsTab) {
  ui.settingsTab = tab;
  ui.overlay = 'settings';
}
