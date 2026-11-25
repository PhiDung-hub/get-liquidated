import { info } from '$lib/transport/info';
import { rateLimited } from '$lib/transport/ws.svelte';
import { net } from '$lib/transport/network';
import { arr, num } from '$lib/util/parse';
import { idbDelete, idbGetWithin, idbPut, rememberKey } from '$lib/util/storage';
import type { Bar } from './candles';
import type { Num } from './indicators';

export const HOUR = 36e5;
/** 480 hourly rows, under HL's 500-row page, so a chunk is one request; a chunk fully in the past is fetched once. */
export const CHUNK = 480 * HOUR;
/** HL publishes an hour's row a few hundred ms after the hour; asking a minute later finds it. */
export const publishedHour = (now: number) => Math.floor((now - 60_000) / HOUR);
/** The oldest chunk asked for: 11 chunks (220 days, past HL's 5000 hourly candles) cap a 1d or 1w chart's first load at 11 requests, not one per 20 days shown. */
export const oldestChunk = (now: number) => (Math.floor(now / CHUNK) - 10) * CHUNK;
export type FundingRow = { time: number; funding: number; premium: number };
/** `since`: the first hour whose row is held, or -Infinity when the chunk before the oldest row came back empty, i.e. the coin's history starts there. */
export type FundingHistory = { rows: FundingRow[]; since: number };
type Cache = { rows: FundingRow[]; done: number[]; hour: number; pending?: Promise<void> };
const caches = new Map<string, Promise<Cache>>();
const row = (r: any): FundingRow => ({ time: num(r.time, 'funding time'), funding: num(r.fundingRate, 'funding rate'), premium: num(r.premium, 'premium') });
const keyOf = (coin: string) => `funding:${net.current}:${coin}`;

const fundingInfo = (payload: object, retries = 3): Promise<any> =>
  info(payload, 10_000).catch((e) => (rateLimited(e) && retries ? fundingInfo(payload, retries - 1) : Promise.reject(e)));

async function readCache(key: string): Promise<Cache> {
  const none = { rows: [], done: [], hour: 0 };
  try {
    const c = (await idbGetWithin(key, 1000)) as any;
    if (c == null) return none;
    return { rows: arr<any>(c.rows, 'cached funding').map((r) => row({ time: r.time, fundingRate: r.funding, premium: r.premium })), done: arr(c.done, 'funding chunks').map((s) => num(s, 'funding chunk')), hour: num(c.hour, 'funding hour') };
  } catch (e) {
    console.warn('funding cache unreadable, asking for history', e);
    return none;
  }
}

const FUNDING_KEPT = 12;
const dropFunding = (k: string) => (caches.delete(k), idbDelete(k).catch((e) => console.warn('funding cache: could not drop', k, e)));

async function fetchChunk(c: Cache, coin: string, s: number) {
  const start = (c.rows.findLast((r) => r.time >= s && r.time < s + CHUNK)?.time ?? s - 1) + 1;
  const page = arr<any>(await fundingInfo({ type: 'fundingHistory', coin, startTime: start, endTime: s + CHUNK - 1 }), 'funding history').map(row);
  if (page.some((r) => r.time < start || r.time >= s + CHUNK)) throw new Error('funding history outside requested range');
  c.rows = [...c.rows, ...page].sort((a, b) => a.time - b.time);
  return page.length;
}

/**
 * Newest chunk first back to the one holding `from` or oldestChunk, whichever is newer: a past chunk once, the current one once per published hour, each from the newest row held.
 * A past chunk with nothing in or before it is where the coin's history starts, so older ones are not asked for.
 */
async function fill(c: Cache, coin: string, from: number) {
  const now = Date.now();
  const hour = publishedHour(now);
  let changed = false;
  try {
    for (let s = Math.floor(now / CHUNK) * CHUNK; s >= Math.max(Math.floor(from / CHUNK) * CHUNK, oldestChunk(now)); s -= CHUNK) {
      const current = s + CHUNK > now;
      const due = current ? c.hour !== hour : !c.done.includes(s);
      const got = due ? await fetchChunk(c, coin, s) : 0;
      changed ||= due;
      if (due && current) c.hour = hour;
      if (due && !current && got < 500) c.done.push(s);
      if (!current && (c.rows[0]?.time ?? Infinity) >= s + CHUNK) break;
    }
  } finally {
    if (changed) idbPut(keyOf(coin), { rows: c.rows, done: c.done, hour: c.hour }).then(() => rememberKey('trade-ui:funding-keys', keyOf(coin), FUNDING_KEPT, dropFunding), (e) => console.warn('funding cache: could not save', e));
  }
}

/** Every hourly row this browser holds for `coin`, after fetching what is missing from `from` to now; calls for one coin run in turn. */
export async function fundingHistory(coin: string, from: number): Promise<FundingHistory> {
  const key = keyOf(coin);
  if (!caches.has(key)) caches.set(key, readCache(key));
  const c = await caches.get(key)!;
  const run = () => fill(c, coin, from);
  const p = (c.pending ?? Promise.resolve()).then(run, run);
  c.pending = p;
  await p;
  const first = c.rows[0]?.time ?? Infinity;
  return { rows: c.rows, since: c.done.includes(Math.floor(first / CHUNK) * CHUNK - CHUNK) ? -Infinity : Math.floor(first / HOUR) * HOUR - HOUR };
}

/**
 * Funding (summed) and premium (the last) in % per bar. A row at T settles the hour before T, so it lands in the bar that hour falls in;
 * bars under an hour step their hour's row. A bar starting before `since` would sum only part of its hours, so it has no funding.
 */
export function fundingValues({ rows, since }: FundingHistory, bars: Bar[], step: number): { funding: Num[]; premium: Num[] } {
  let j = 0;
  const funding: Num[] = [], premium: Num[] = [];
  for (const b of bars) {
    const from = step < HOUR ? Math.floor(b.time / HOUR) * HOUR : b.time;
    const to = from + Math.max(step, HOUR);
    while (j < rows.length && rows[j].time - HOUR < from) j++;
    let sum = 0, last: Num = null;
    for (let i = j; i < rows.length && rows[i].time - HOUR < to; i++) [sum, last] = [sum + rows[i].funding, rows[i].premium];
    funding.push(last === null || from < since ? null : sum * 100);
    premium.push(last === null ? null : last * 100);
  }
  return { funding, premium };
}
