import { info } from '$lib/transport/info';
import { arr, num } from '$lib/util/parse';
import { meta } from '$lib/market/meta.svelte';
import { net } from '$lib/transport/network';
import { fresh, keep } from '$lib/util/storage';

type Staking = { stakedHype: number | null; stakingDiscount: number | null; nextStaking: number | null; nextStakingDiscount: number | null };
type Fees = Staking & { taker: number; maker: number; spotTaker: number; spotMaker: number; tier: number | null; vol: number; next: number | null };
const NO_STAKING: Staking = { stakedHype: null, stakingDiscount: null, nextStaking: null, nextStakingDiscount: null };
const BASE: Fees = { taker: 0.00045, maker: 0.00015, spotTaker: 0.0007, spotMaker: 0.0004, tier: null, vol: NaN, next: null, ...NO_STAKING };
export const fees = $state<Fees>({ ...BASE });
const cache = new Map<string, Fees>();
let current: string | null = null;

/** As HL's fee schedule reads it: 14d volume is every day but today, and the tier counts the cutoffs that volume exceeds. */
function tierOf(r: any): Pick<Fees, 'tier' | 'vol' | 'next'> {
  try {
    const vol = arr<any>(r.dailyUserVlm, 'dailyUserVlm').slice(0, -1).reduce((t, d) => t + num(d.userCross, 'userCross') + num(d.userAdd, 'userAdd'), 0);
    const cuts = arr<any>(r.feeSchedule?.tiers?.vip, 'vip').map((t) => num(t.ntlCutoff, 'ntlCutoff'));
    const tier = cuts.filter((c) => vol > c).length;
    return { tier, vol, next: cuts[tier] ?? null };
  } catch (e) {
    console.warn('userFees tier dropped', e);
    return { tier: null, vol: NaN, next: null };
  }
}

function stakingOf(r: any): Staking {
  const staking = { ...NO_STAKING };
  const bounded = (v: unknown, field: string, max: number) => {
    const n = num(v, field);
    if (n < 0 || n > max) throw new Error(`${field} outside 0–${max}`);
    return n;
  };
  try {
    if (r.activeStakingDiscount == null) return staking;
    const bps = bounded(r.activeStakingDiscount.bpsOfMaxSupply, 'staking bpsOfMaxSupply', 10_000);
    const discount = bounded(r.activeStakingDiscount.discount, 'staking discount', 1);
    // One bp of HYPE's 1B maximum supply is 100,000 HYPE; the active value is fee-attributed stake, not a tier floor.
    staking.stakedHype = bps * 100_000;
    staking.stakingDiscount = discount;
  } catch (e) {
    console.warn('userFees staking dropped', e);
    return staking;
  }
  try {
    if (r.stakingLink?.type === 'stakingUser') return staking;
    const tiers = arr<any>(r.feeSchedule?.stakingDiscountTiers, 'stakingDiscountTiers').map((t) => ({
      cutoff: bounded(t.bpsOfMaxSupply, 'staking cutoff', 10_000) * 100_000,
      discount: bounded(t.discount, 'staking tier discount', 1)
    })).sort((a, b) => a.cutoff - b.cutoff);
    const next = tiers.find((t) => t.discount > staking.stakingDiscount!);
    staking.nextStaking = next?.cutoff ?? null;
    staking.nextStakingDiscount = next?.discount ?? null;
  } catch (e) {
    console.warn('userFees staking tiers dropped', e);
  }
  return staking;
}

/** The user rates already carry the staking discount; HL takes the referral discount off them, never off a rebate. */
function parseFees(r: any): Fees {
  const off = 1 - num(r.activeReferralDiscount ?? 0, 'activeReferralDiscount');
  const cut = (rate: number) => (rate > 0 ? rate * off : rate);
  return {
    taker: num(r.userCrossRate, 'userCrossRate') * off, maker: cut(num(r.userAddRate, 'userAddRate')),
    spotTaker: num(r.userSpotCrossRate ?? BASE.spotTaker, 'userSpotCrossRate') * off, spotMaker: cut(num(r.userSpotAddRate ?? BASE.spotMaker, 'userSpotAddRate')), ...tierOf(r), ...stakingOf(r)
  };
}

/** One userFees read per viewed account, reused by this browser's next loads for 10 minutes; until it lands, on failure, or with no account, the base rates show and the tier is unknown. */
export async function loadFees(user: string | null): Promise<void> {
  current = user;
  Object.assign(fees, (user && cache.get(user)) || BASE);
  if (!user || cache.has(user)) return;
  const key = `trade-ui:fees:${net.current}:${user}`;
  try {
    const hit = fresh<any>(key, 600_000);
    const r = hit ?? (await info<any>({ type: 'userFees', user }));
    const f = parseFees(r);
    if (!hit) keep(key, r);
    cache.set(user, f);
    if (current === user) Object.assign(fees, f);
  } catch (e) {
    console.warn('userFees failed', e);
  }
}

/** HIP-3 scales the account's rates by the deployer's fee scale, a tenth of that in growth mode (spec Fact 5); a maker rebate stays unscaled. */
export function feeFor(coin: string): { taker: number; maker: number; scaled: boolean } {
  const a = meta.byName.get(coin);
  if (a?.spot) return { taker: fees.spotTaker, maker: fees.spotMaker, scaled: false };
  if (!a?.dex) return { taker: fees.taker, maker: fees.maker, scaled: false };
  const k = (a.feeScale < 1 ? 1 + a.feeScale : 2 * a.feeScale) * (a.growth ? 0.1 : 1);
  return { taker: fees.taker * k, maker: fees.maker > 0 ? fees.maker * k : fees.maker, scaled: true };
}
