import { ALL_INTERVALS, MS, type Interval } from '$lib/market/candles';

/** HL keeps about the newest 5,000 bars per interval; the rest of that is the bars padded in before a date. */
const KEPT_BARS = 4900;
const MOST_BARS = 2200;
const FEWEST_BARS = 30;
/** Bars per plot pixel at the chart's minBarSpacing, less the room for a range's right margin: any more and the chart drops the left of the range. */
const BARS_PER_PX = 4.8;

/** Days shown by each chart range; 0 is the year so far, Infinity the market's whole life. */
export const RANGES: [string, number][] = [['1D', 1], ['5D', 5], ['1M', 30], ['3M', 91], ['6M', 182], ['YTD', 0], ['1Y', 365], ['5Y', 1826], ['All', Infinity]];

const kept = (interval: Interval, back: number) => back < KEPT_BARS * MS[interval];

/** The finest interval HL still keeps that far back that the plot can show: matches HL's ranges up to 6M, and is finer than its weekly bars on 1Y and 5Y. */
export function rangeInterval(span: number, back: number, width: number, keep?: Interval): Interval {
  const most = Math.min(MOST_BARS, width * BARS_PER_PX);
  const fits = (i: Interval) => span / MS[i] <= most && kept(i, back);
  if (keep && fits(keep) && span / MS[keep] >= FEWEST_BARS) return keep;
  return ALL_INTERVALS.find(fits) ?? '1M';
}

export const reachInterval = (current: Interval, back: number): Interval =>
  ALL_INTERVALS.find((i) => MS[i] >= MS[current] && kept(i, back)) ?? '1M';

export const today = (zone: string, at: number) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(at);

/** Epoch ms of a date and time as read on a clock in the zone. The offset is read twice, as a clock near a DST change has a different one at UTC than at the answer. */
export function zoned(date: string, time: string, zone: string): number {
  const utc = Date.parse(`${date}T${time || '00:00'}Z`);
  if (Number.isNaN(utc)) return NaN;
  const format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
  const offset = (at: number) => {
    const parts = format.formatToParts(at);
    const n = (type: string) => Number(parts.find((p) => p.type === type)!.value);
    const shown = new Date(0);
    shown.setUTCFullYear(n('year'), n('month') - 1, n('day'));
    return shown.setUTCHours(n('hour'), n('minute')) - Math.floor(at / 6e4) * 6e4;
  };
  return utc - offset(utc - offset(utc));
}
