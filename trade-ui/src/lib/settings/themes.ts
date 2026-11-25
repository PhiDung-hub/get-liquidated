/** Shared with the journal, which trade-ui serves from the same origin: one theme and text size for both. */
export const SETTINGS_KEY = 'trade-ui:settings';

export const THEMES = [
  { id: 'getliq', name: 'Get Liquidated', colors: ['#111214', '#68e0cd', '#f69391'] },
  { id: 'hyperliquid', name: 'Hyperliquid', colors: ['#0f1a1e', '#76ead7', '#ffa3b5'] },
  { id: 'paper', name: 'Paper', colors: ['#e6e1d6', '#06705c', '#ad2e44'] },
  { id: 'bloomberg', name: 'Bloomberg', colors: ['#000000', '#ff9f1a', '#6fdb91'] }
] as const;
export type ThemeId = (typeof THEMES)[number]['id'];

export const FS_RANGE = [8, 18] as const;
