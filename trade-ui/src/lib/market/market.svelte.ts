import { load, save } from '$lib/util/storage';
import { kindOf, listState, meta, unlisted, type Ctx } from './meta.svelte';

const KEY = 'trade-ui:coin';
const stored = load(KEY, 'BTC');
let pending = kindOf(stored) !== 'perp' ? stored : '';

export const market = $state({ coin: pending ? 'BTC' : stored, ctx: null as Ctx | null, switchedAt: 0 });

export function selectCoin(coin: string, keep = true) {
  if (coin === market.coin || unlisted(coin)) return;
  pending = '';
  market.coin = coin;
  market.ctx = null;
  market.switchedAt = Date.now();
  if (keep) save(KEY, coin);
}

/**
 * Selects the stored HIP-3 or spot coin once meta lists it, from the cached list too. `final` is the fresh answer of the `kind` list:
 * that coin, or one of its kind picked from the cached list meanwhile, falls back to BTC when it no longer lists it, and is returned.
 */
export function restoreCoin(final = true, kind?: 'hip3' | 'spot'): string {
  const own = (c: string) => kindOf(c) !== 'perp' && (!kind || kindOf(c) === kind);
  const was = pending;
  const coin = own(was) ? was : final && own(market.coin) ? market.coin : '';
  if (!coin) return '';
  const a = meta.byName.get(coin);
  const ok = !!a && !a.isDelisted;
  if (ok) selectCoin(coin);
  pending = !final ? coin : coin === was ? '' : was;
  if (ok || !final) return '';
  selectCoin('BTC', false);
  // A list off can be one 429 at load; the stored coin comes back on the next good load.
  if (listState(kindOf(coin)) !== 'off') save(KEY, market.coin);
  return coin;
}
