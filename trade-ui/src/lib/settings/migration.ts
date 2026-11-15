import { TICKET_KINDS, importJson, settings, validNum, validTimezone } from './settings.svelte';
import { meta, nameOf } from '$lib/market/meta.svelte';
import { maxDecimals } from '$lib/signing/wire';
import { INTERVALS } from '$lib/market/candles';
import { DEFS, defaults, MAX_PANES, MAX_STUDIES, newId, ownPanes, validInput, type Study } from '$lib/market/studies';

export const MIGRATION_LIMIT = 65_536;
export const EXTRACTION_SCRIPT = `(() => {
  if (location.origin !== 'https://app.hyperliquid.xyz') throw new Error('Open app.hyperliquid.xyz first');
  const preferences = {};
  let bytes = 0;
  const read = key => {
    const text = localStorage.getItem(key);
    if (text === null) return undefined;
    bytes += new TextEncoder().encode(text).length;
    if (text.length > 65536 || bytes > 262144) throw new Error('Preference exceeds export limit');
    return JSON.parse(text);
  };
  for (const key of ['favorite-coins', 'hyperliquid.max_slippage']) {
    const value = read(key);
    if (value !== undefined) preferences[key] = value;
  }
  const properties = read('tradingview.chartproperties');
  const series = read('tradingview.chartproperties.mainSeriesProperties') ?? properties?.mainSeriesProperties;
  const chart = {};
  if (properties?.timezone !== undefined) chart.timezone = properties.timezone;
  if (series?.interval !== undefined) chart.interval = series.interval;
  if (series?.style !== undefined) chart.style = series.style;
  if (Object.keys(chart).length) preferences.chart = chart;
  const text = JSON.stringify({format: 'hyperliquid-preferences', version: 1, preferences}, null, 2);
  if (new TextEncoder().encode(text).length > 65536) throw new Error('Export exceeds 64 KiB');
  return text;
})()`;

const STUDY_GUIDE = Object.values(DEFS).filter(d => !d.flow && !d.data).map(d =>
  `${d.type}: ${d.inputs.map(i => `${i.id} (${i.label})${i.options ? ' = ' + i.options.join('/') : ` ${i.kind} ${i.min}–${i.max}`}`).join(', ')}`
).join('\n');

export const AGENT_MIGRATION_PROMPT = `Walk me through moving my Hyperliquid preferences to Get Liquidated. Use Claude Code or Codex with the local getliq companion if available; no repository access is needed. The companion does not read browser storage: use only an already authorized local browser connection. If browser access is unavailable, guide me through the collapsed manual route in “Move from Hyperliquid”; do not install access or attach to another profile.

Keep exports local, never print them in chat, tool logs, telemetry or network services. Never enumerate storage or read cookies, session storage, IndexedDB, wallet/privy/wagmi/appkit/auth stores, keys, agents, tokens or account connections. Do not connect or authorize wallets, sign messages, place/cancel orders or trade. Do not bypass console paste protection.

1. In the destination, open “Move from Hyperliquid” from Settings, the top bar, the AI card or hotkey help. Click “Back up current settings” before proceeding. Stop if it cannot save the backup.
2. In my usual https://app.hyperliquid.xyz tab execute exactly this allowlisted script. It writes nothing and makes no requests. Do not broaden it. Keep the result out of logs; if your browser tool cannot transfer it without logging, let me copy and paste it myself.

\`\`\`javascript
${EXTRACTION_SCRIPT}
\`\`\`

3. The script covers stars, slippage and saved chart preferences only. For the rest, walk me through the visible Hyperliquid UI: read the current chart interval/type/timezone and active studies, their input values, plot visibility and overall visibility; order-book grouping and current market; order type and size unit. Never change orders or account settings. When available, use these visible values to correct stale chart defaults in the export. If live Hyperliquid access is paused, do not open or probe it; use existing captures or ask me for the visible preferences instead.
4. Add only values actually verified in the UI to the same envelope's preferences, using the schema below. Omit unavailable groups. Never infer a spot/HIP-3 symbol; keep its exact id or full BASE/QUOTE pair for the destination's metadata resolver. If you only see an ambiguous ticker, leave it for me. Do not copy order sizes, leverage, margin, reduce-only, TP/SL, confirmation bypasses, addresses or connections.
5. Paste the JSON into “Hyperliquid migration JSON”. The live preview validates it. Leave all checkboxes unchecked and STOP for me to review warnings, select groups and click “Import selected preferences”. Preserve unrelated settings. Stars/studies replace their lists; an explicitly empty list clears them. The destination saves a backup before import; “Restore backup” undoes it. Tell me to verify the chart, stars and execution settings before trading.

Envelope: {"format":"hyperliquid-preferences","version":1,"preferences":{...}}
Allowed preferences:
- "favorite-coins": array of exact market ids/full spot pairs, at most 100.
- "hyperliquid.max_slippage": fraction, not percentage (0.01 = 1%); destination accepts 0.0001–0.1, never clamp.
- "chart": {"interval":"15", "style":1, "timezone":"Asia/Singapore"}. TradingView intervals: 1,5,15,60,240,720,1D,1W (or destination 1m,5m,15m,1h,4h,12h,1d,1w). Only candles (style 1) have an equivalent here; other types are skipped with a warning.
- "studies": [{"name":"Moving Average Triple","inputs":{"first":7,"second":30,"third":99,"method":"Simple"},"visible":true,"plots":[true,false,true]}]. Use exact names and input ids/labels from the registry below. Include all inputs, not guessed defaults. At most 12 studies / 4 separate panes. RSI uses close only; skip variants with a different source or smoothing. Unsupported studies/inputs must be listed as skipped. Include Volume explicitly even when removed (visible false). Volume is already built in: {"name":"Volume","inputs":{},"visible":true}; its smoothing inputs have no equivalent.
- "book": {"bins":{"BTC":10}}. Only an exact absolute price grouping step on a resolved market maps; do not convert significant-figure grouping without a verified price step. Denomination is coin-only here, so other denominations have no equivalent.
- "order": {"kind":"limit","sizeUnit":"coin"}. kind: market,limit,scale,chase,stopLimit,stopMarket,takeLimit,takeMarket; sizeUnit: coin,usd. Map only the corresponding visible type/unit; never copy a typed size or price. Unsupported types (TWAP, trailing stop) are skipped.
This schema is for local UI transcription, not a claim about unverified Hyperliquid storage keys. Missing values remain unchanged. Maximum JSON size: 64 KiB. Chart drawings, layouts, colour styles and hotkeys have no verified mapping.

Study registry (numeric values must fit the destination's input ranges):
${STUDY_GUIDE}`;

export interface MigrationField {
  id: 'favourites' | 'slippage' | 'chart' | 'studies' | 'book' | 'order';
  label: string;
  detail: string;
  patch: Record<string, unknown>;
}
export interface MigrationPreview { fields: MigrationField[]; warnings: string[] }
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const symbol = (v: unknown): v is string => typeof v === 'string' && /^[\w:@./-]{1,100}$/.test(v);
const safeName = (v: unknown) => typeof v === 'string' && /^[\w %/().:-]{1,80}$/.test(v) ? v : '(unrecognized)';

function resolve(value: unknown, warnings: string[]): string | null {
  if (!symbol(value)) { warnings.push('Favorites/book: invalid symbol skipped.'); return null; }
  const exact = meta.byName.get(value);
  if (exact && !exact.isDelisted) return exact.name;
  const matches = meta.spot.filter(a => !a.isDelisted && `${a.base}/${a.collateral}` === value);
  if (matches.length === 1) return matches[0].name;
  warnings.push(`Unresolved market: ${value}. Load market metadata or select it manually; skipped.`);
  return null;
}

export function previewMigration(text: string): MigrationPreview {
  if (text.length > MIGRATION_LIMIT || new TextEncoder().encode(text).length > MIGRATION_LIMIT) throw new Error('Export exceeds 64 KiB limit');
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('Paste a valid migration JSON export'); }
  if (!record(raw) || raw.format !== 'hyperliquid-preferences' || raw.version !== 1 || !record(raw.preferences))
    throw new Error('Expected hyperliquid-preferences version 1');
  const fields: MigrationField[] = [], warnings: string[] = [];
  const prefs = raw.preferences;
  const add = (id: MigrationField['id'], label: string, detail: string, patch: Record<string, unknown>) => fields.push({ id, label, detail, patch });
  const unknown = (value: Record<string, unknown>, allowed: string[]) => {
    if (Object.keys(value).some(k => !allowed.includes(k))) warnings.push('Unsupported fields ignored; their names and values are not displayed or imported.');
  };
  unknown(raw, ['format', 'version', 'preferences']);
  unknown(prefs, ['favorite-coins', 'hyperliquid.max_slippage', 'chart', 'studies', 'book', 'order']);
  if (Object.hasOwn(prefs, 'favorite-coins')) {
    const list = prefs['favorite-coins'];
    if (!Array.isArray(list) || list.length > 100) warnings.push('Favorites: expected at most 100 symbols.');
    else {
      const coins = [...new Set(list.map(c => resolve(c, warnings)).filter((c): c is string => c !== null))];
      if (coins.length || list.length === 0) add('favourites', 'Replace starred markets', coins.map(nameOf).join(', ') || '(empty list)', { favourites: coins });
    }
  }
  if (Object.hasOwn(prefs, 'hyperliquid.max_slippage')) {
    const value = prefs['hyperliquid.max_slippage'];
    if (validNum('market.slippage', value)) add('slippage', 'Market slippage', `${Number((value * 100).toFixed(4))}% · affects future market orders`, { market: { slippage: value } });
    else warnings.push('Market slippage is invalid or outside this app’s 0.01–10% range; skipped.');
  }
  if (Object.hasOwn(prefs, 'chart')) {
    const c = prefs.chart, chart: Record<string, unknown> = {}, detail: string[] = [];
    if (!record(c)) warnings.push('Chart: expected an object; skipped.');
    else {
      unknown(c, ['interval', 'style', 'timezone']);
      if (Object.hasOwn(c, 'interval')) {
        const iv = typeof c.interval === 'string' ? ({ '1': '1m', '5': '5m', '15': '15m', '60': '1h', '240': '4h', '720': '12h', '1D': '1d', '1W': '1w' }[c.interval] ?? c.interval) : '';
        if (INTERVALS.includes(iv as typeof INTERVALS[number])) { chart.interval = iv; detail.push(iv); }
        else warnings.push('Chart interval has no equivalent; skipped.');
      }
      if (Object.hasOwn(c, 'timezone')) {
        if (validTimezone(c.timezone)) { chart.timezone = c.timezone; detail.push(c.timezone); }
        else warnings.push('Chart timezone is invalid; skipped.');
      }
      if (Object.hasOwn(c, 'style')) {
        if (c.style === 1) detail.push('Candles');
        else warnings.push('Chart type has no equivalent (this app uses candles); skipped.');
      }
      if (Object.keys(chart).length) add('chart', 'Chart preferences', detail.join(' · '), { chart });
    }
  }
  if (Object.hasOwn(prefs, 'studies')) {
    const list = prefs.studies, studies: Study[] = [];
    let volume: boolean | undefined;
    if (!Array.isArray(list) || list.length > 100) warnings.push('Studies: expected at most 100 entries; skipped.');
    else {
      for (const s of list) {
        if (!record(s)) { warnings.push('Malformed study skipped.'); continue; }
        const name = safeName(s.name);
        unknown(s, ['name', 'inputs', 'visible', 'plots']);
        if (s.name === 'Volume' && record(s.inputs) && !Object.keys(s.inputs).length && typeof s.visible === 'boolean' && (s.plots === undefined || (Array.isArray(s.plots) && s.plots.length === 1 && typeof s.plots[0] === 'boolean'))) { volume = s.visible && s.plots?.[0] !== false; continue; }
        const aliases: Record<string, string> = { 'Triple MA': 'Moving Average Triple', RSI: 'Relative Strength Index' };
        const type = typeof s.name === 'string' ? aliases[s.name] ?? s.name : '';
        const def = DEFS[type];
        if (!def || def.flow || def.data) { warnings.push(`Study skipped: ${name} (no equivalent).`); continue; }
        if (studies.length >= MAX_STUDIES || (def.pane === 'own' && ownPanes(studies) >= MAX_PANES)) { warnings.push(`Study skipped: ${name} (chart capacity).`); continue; }
        if (!record(s.inputs) || typeof s.visible !== 'boolean' || (s.plots !== undefined && (!Array.isArray(s.plots) || s.plots.length !== def.plots.length || !s.plots.every((v: unknown) => typeof v === 'boolean')))) {
          warnings.push(`Study skipped: ${name} (invalid inputs or visibility).`); continue;
        }
        const inputs = defaults(def);
        const keys = new Set(def.inputs.flatMap(i => [i.id, i.label]));
        const invalid = Object.keys(s.inputs).some(k => !keys.has(k)) || def.inputs.some(i => {
          const v = s.inputs[i.id] ?? s.inputs[i.label];
          if (!validInput(i, v) || (s.inputs[i.id] !== undefined && s.inputs[i.label] !== undefined && s.inputs[i.id] !== s.inputs[i.label])) return true;
          inputs[i.id] = v;
          return false;
        });
        if (invalid) { warnings.push(`Study skipped: ${name} (unsupported, missing or invalid input).`); continue; }
        studies.push({ id: newId(type, studies), type, inputs, hidden: !s.visible, ...(s.plots && { plots: s.plots.map((on: boolean) => ({ on })) }) });
      }
      if (studies.length || volume !== undefined || !list.length) {
        const chart = { ...(studies.length || !list.length ? { studies } : {}), ...(volume !== undefined ? { volume } : {}) };
        const detail = studies.map(s => `${s.type} (${Object.values(s.inputs).join(', ')})${s.hidden ? ' · hidden' : ''}${s.plots?.some(p => !p.on) ? ' · some plots hidden' : ''}`);
        if (volume !== undefined) detail.push(`Volume · ${volume ? 'shown' : 'hidden'} (built in)`);
        add('studies', 'Replace chart studies', detail.join('; ') || '(empty list; built-in Volume unchanged)', { chart });
      }
    }
  }
  if (Object.hasOwn(prefs, 'book')) {
    const b = prefs.book;
    if (!record(b) || !record(b.bins) || Object.keys(b.bins).length > 100) warnings.push('Book: expected at most 100 market grouping steps; skipped.');
    else {
      unknown(b, ['bins']);
      const bins: Record<string, number> = {};
      for (const [coin, step] of Object.entries(b.bins)) {
        const id = resolve(coin, warnings);
        if (id && typeof step === 'number' && Number.isFinite(step) && step >= 10 ** -maxDecimals(meta.byName.get(id)!) && step <= 1e12 && [1, 2, 5].includes(Number(step.toExponential().split('e')[0]))) bins[id] = step;
        else if (id) warnings.push('Book: invalid or unsupported grouping step skipped.');
      }
      if (Object.keys(bins).length) add('book', 'Order book grouping', Object.entries(bins).map(([c, n]) => `${nameOf(c)}: ${n}`).join(', '), { book: { bins } });
    }
  }
  if (Object.hasOwn(prefs, 'order')) {
    const o = prefs.order, panel: Record<string, unknown> = {};
    if (!record(o)) warnings.push('Order defaults: expected an object; skipped.');
    else {
      unknown(o, ['kind', 'sizeUnit']);
      if (Object.hasOwn(o, 'kind')) {
        if ((TICKET_KINDS as readonly string[]).includes(o.kind)) panel.kind = o.kind;
        else warnings.push('Order type has no equivalent; skipped.');
      }
      if (Object.hasOwn(o, 'sizeUnit')) {
        if (['coin', 'usd'].includes(o.sizeUnit)) panel.sizeUnit = o.sizeUnit;
        else warnings.push('Order size unit has no equivalent; skipped.');
      }
      if (Object.keys(panel).length) add('order', 'Order defaults', Object.values(panel).join(' · '), { panel });
    }
  }
  return { fields, warnings: [...new Set(warnings)] };
}

export function applyMigration(text: string, selected: string[], expected: MigrationPreview): string[] {
  const preview = previewMigration(text);
  if (JSON.stringify(preview) !== JSON.stringify(expected)) throw new Error('Preview changed. Review and select the groups again.');
  const patch: Record<string, any> = {};
  for (const field of preview.fields.filter(f => selected.includes(f.id))) {
    for (const [key, value] of Object.entries(field.patch)) patch[key] = record(value) ? { ...patch[key], ...value } : value;
  }
  if (!Object.keys(patch).length) throw new Error('Select at least one supported setting');
  if (patch.book) patch.book.bins = { ...settings.book.bins, ...patch.book.bins };
  return importJson(JSON.stringify(patch));
}
