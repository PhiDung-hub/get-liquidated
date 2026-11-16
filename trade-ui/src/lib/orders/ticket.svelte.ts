import type { Tif } from '$lib/exchange/actions';
import { roundSz } from '$lib/signing/wire';
import { settings, type SizeUnit, type TICKET_KINDS } from '$lib/settings/settings.svelte';

export type TicketKind = (typeof TICKET_KINDS)[number];
export type TriggerKind = Exclude<TicketKind, 'market' | 'limit' | 'scale' | 'chase'>;

export const ticket = $state({
  kind: settings.panel.kind, isBuy: true, size: 0, unit: settings.panel.sizeUnit as SizeUnit, basis: 'balance' as 'balance' | 'position',
  px: '', trigger: '', tif: 'Gtc' as Tif, reduceOnly: false, tpsl: false, tp: '', sl: '', scaleCount: '', scaleSkew: ''
});

/** The ticket's send in flight and its last error. */
export const placing = $state({ busy: false, error: '' });
/** Sends confirmed in a position dialog and still in flight. */
export const closing = $state({ n: 0 });

/** `szDecimals` is the selected coin's; USD and % sizes keep 2 places. */
export function nudgeSize(dir: 1 | -1, szDecimals: number) {
  ticket.size = roundSz(Math.max(0, Number((ticket.size * (1 + dir * settings.sizeStep)).toPrecision(6))), ticket.unit === 'coin' ? szDecimals : 2);
}
