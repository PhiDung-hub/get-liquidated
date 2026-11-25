<script lang="ts">
  import { tick, untrack, type Snippet } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { market, selectCoin } from '$lib/market/market.svelte';
  import { isSpot, meta, parseCtx, parseSpotCtx, quoteOf, symOf, type Ctx } from '$lib/market/meta.svelte';
  import { safe } from '$lib/market/watch.svelte';
  import { removeQuick, topChips } from '$lib/market/views.svelte';
  import { socket } from '$lib/transport/ws.svelte';
  import { settings, persist, DEFAULTS } from '$lib/settings/settings.svelte';
  import ThemePicker from './ThemePicker.svelte';
  import { resumeWallet, session, walletReady } from '$lib/session/session.svelte';
  import { fmtIn, fmtUsd, fmtNum, fmtPct, fmtPx, fmtSz, pxDecimals } from '$lib/util/format';
  import { openSettings, ui } from './state.svelte';
  import { load, save } from '$lib/util/storage';
  import Coin from './Coin.svelte';
  import Connection from './Connection.svelte';
  import AccountSwitch from './AccountSwitch.svelte';
  import ZenToggle from './ZenToggle.svelte';
  import FundingRate from './FundingRate.svelte';
  import { inZen } from './zen';

  let { portrait, children }: { portrait: boolean; children: Snippet<[Snippet, Snippet, Snippet]> } = $props();

  let suggestMigration = $state(false);
  let migrationChecked = false;
  $effect(() => {
    if (!session.master || session.linked || migrationChecked) return;
    migrationChecked = true;
    const defaultsUnchanged = untrack(() => JSON.stringify($state.snapshot(settings)) === JSON.stringify(DEFAULTS));
    if (defaultsUnchanged && !load('trade-ui:migration-suggested', false)) suggestMigration = true;
  });
  function dismissMigration() {
    suggestMigration = false;
    save('trade-ui:migration-suggested', true);
  }

  const ctx = $derived(market.ctx ?? meta.ctxs.get(market.coin) ?? null);
  const instrument = $derived(meta.byName.get(market.coin));
  const szDec = $derived(instrument?.szDecimals ?? 0);
  // Spot has no oracle, open interest, funding or leverage; its volume is in the quote token.
  const spot = $derived(isSpot(market.coin));
  const quote = $derived(quoteOf(market.coin));
  const change = $derived(ctx ? (ctx.markPx - ctx.prevDayPx) / ctx.prevDayPx : NaN);
  const phone = new MediaQuery('max-width: 900px');
  const diff = $derived(ctx ? ctx.markPx - ctx.prevDayPx : NaN);
  const dayMove = $derived.by(() => {
    if (!ctx || !Number.isFinite(diff)) return '—';
    const abs = fmtNum(Math.abs(diff), Math.max(2, pxDecimals(ctx.markPx, szDec, spot)));
    return `${diff >= 0 ? '+' : '-'}${quote === 'USDC' ? `$${abs}` : `${abs} ${quote}`}`;
  });
  const oiHelp = 'Two-sided open interest is the total size of open long and short positions in this contract.';
  const fundingHelp = 'Positive hourly funding is paid by longs to shorts. When the rate is negative, shorts pay longs. Funding is a peer-to-peer transfer with no fees that keeps the perpetual price closer to spot. The countdown shows time until the next settlement.';
  const oracleHelp = $derived(instrument?.dex
    ? 'The reference price for funding payments. See the HIP-3 deployer’s documentation for details.'
    : 'The median of external prices reported by validators. Hyperliquid uses it to calculate funding rates.');
  const markHelp = 'Used for margin, unrealized PnL, liquidations, and triggering take-profit and stop-loss orders.';
  let statsOpen = $state(false);
  function toAccountTab() {
    settings.display.phoneTab = 'account';
    persist();
  }
  const fold = new MediaQuery('min-width: 600px');
  const info = $derived(!phone.current || fold.current);
  const favs = $derived(topChips());
  const live = $state<Record<string, Ctx>>({});
  // Keyed by the names, so a meta publish that keeps the same chips does not resubscribe them.
  const favKey = $derived(favs.join(','));
  $effect(() => {
    const offs = (favKey && info && !inZen() ? favKey.split(',') : []).map((coin) => socket.subscribe({ type: 'activeAssetCtx', coin }, safe('favourite ctx', (d) => (live[coin] = isSpot(coin) ? parseSpotCtx(d.ctx) : parseCtx(d.ctx)))));
    return () => offs.forEach((off) => off());
  });
  function chip(coin: string) {
    const c = live[coin] ?? meta.ctxs.get(coin);
    return c && { px: fmtPx(c.markPx, meta.byName.get(coin)?.szDecimals, isSpot(coin)), chg: (c.markPx - c.prevDayPx) / c.prevDayPx };
  }
  $effect(() => {
    if (walletReady()) untrack(resumeWallet);
  });
  /** A keyboard removal hands focus to the chip that takes its place, so the next Delete keeps going. */
  async function unchip(coin: string, refocus: boolean) {
    const i = favs.indexOf(coin);
    removeQuick(coin);
    if (!refocus) return;
    await tick();
    const chips = document.querySelectorAll<HTMLElement>('[data-testid="fav-chip"]');
    (chips[Math.min(i, chips.length - 1)] ?? document.querySelector<HTMLElement>('[data-testid="quick-open"]'))?.focus();
  }
  let strip = $state<HTMLElement>();
  let overflow = $state(false);
  let atStart = $state(true);
  let atEnd = $state(true);

  function measure(viewport: HTMLElement) {
    const track = viewport.firstElementChild!;
    const update = () => {
      overflow = track.getBoundingClientRect().width > viewport.parentElement!.clientWidth + 1;
      atStart = viewport.scrollLeft <= 1;
      atEnd = viewport.scrollLeft + viewport.clientWidth >= viewport.scrollWidth - 1;
    };
    update();
    const observer = new ResizeObserver(update);
    for (const el of [viewport.parentElement!, viewport, track]) observer.observe(el);
    viewport.addEventListener('scroll', update, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener('scroll', update);
    };
  }
</script>

{#snippet chipStrip()}
{#if favs.length}
  <div class="quick-strip">
    {#if overflow}<button class="scroll" aria-label="Show earlier pinned markets" disabled={atStart} onclick={() => strip?.scrollBy(-strip.clientWidth, 0)}>‹</button>{/if}
    <nav bind:this={strip} {@attach measure} class="chips" data-testid="fav-chips" data-superstar={settings.display.superstar} aria-label="Quick-switch markets">
      <div class="chip-track">
        {#each favs as coin (coin)}
          {@const c = chip(coin)}
          <span class="slot">
            <button class="chip" data-testid="fav-chip" data-coin={coin} aria-current={coin === market.coin} title={phone.current ? undefined : 'Right-click, middle-click or Delete removes it'} onclick={(e) => (e.currentTarget.blur(), selectCoin(coin))}
              onmousedown={(e) => e.button === 1 && e.preventDefault()} onauxclick={(e) => e.button === 1 && removeQuick(coin)}
              oncontextmenu={(e) => !phone.current && (e.preventDefault(), removeQuick(coin))} onkeydown={(e) => (e.key === 'Delete' || e.key === 'Backspace') && (e.stopPropagation(), unchip(coin, true))}>
              <span class="coin"><Coin {coin} /></span>
              {#if info}
                <span class="px num">{c?.px ?? '—'}</span>
                <span class="chg num" class:buy={c && c.chg >= 0} class:sell={c && c.chg < 0}>{c ? fmtPct(c.chg) : '—'}</span>
              {/if}
            </button>
            {#if !phone.current}<button class="unchip" data-testid="fav-chip-remove" aria-label="Remove {coin} from the top bar" onclick={(e) => unchip(coin, e.detail === 0)}>✕</button>{/if}
          </span>
        {/each}
      </div>
    </nav>
    {#if overflow}<button class="scroll" aria-label="Show more pinned markets" disabled={atEnd} onclick={() => strip?.scrollBy(strip.clientWidth, 0)}>›</button>{/if}
  </div>
{/if}
{#if !phone.current}{@render quickOpen()}{/if}
{/snippet}
{#snippet quickOpen()}
<button class="quick" data-testid="quick-open" aria-label="Edit quick-switch markets" title="Quick-switch markets: add, remove, reorder" onclick={(e) => (e.currentTarget.blur(), (ui.overlay = 'quick'))}>★★</button>
{/snippet}
{#snippet desktopControls()}
  <div class="right">
    <Connection />
    <ThemePicker value={settings.display.theme} onchange={id => { settings.display.theme = id; persist(); }} />
    <button data-testid="settings-button" aria-label="settings" title="Settings (hotkeys, sizes)" onclick={(e) => (e.currentTarget.blur(), openSettings('execution'))}>⚙</button>
  </div>
{/snippet}
{#snippet more()}
<div class="stat"><span class="dim">24h Volume</span><span class="num" data-testid="day-volume">{ctx ? fmtIn(ctx.dayNtlVlm, quote) : '—'}</span></div>
{#if !spot}
<div class="stat">
  <abbr class="dim help-label" title={oiHelp}>Open Interest</abbr>
  <span class="num" data-testid="open-interest" data-help-detail={ctx?.openInterest != null ? `${fmtSz(ctx.openInterest, szDec)} ${symOf(market.coin)}` : undefined}>{ctx?.openInterest != null ? fmtUsd(ctx.openInterest * ctx.markPx) : '—'}</span>
</div>
{/if}
{/snippet}
{#snippet fundingStat()}
{#if !spot}
  {#if phone.current}
    <div class="stat"><abbr class="dim help-label" title={fundingHelp}>Funding</abbr><FundingRate rate={ctx?.funding ?? null} running={!inZen()} /></div>
  {:else}
    <button class="stat funding-history" data-testid="market-funding-open" aria-haspopup="dialog" aria-label="Market funding history" data-help-detail={fundingHelp} onclick={() => (ui.overlay = 'marketFunding')}>
      <span class="dim help-label">Funding / Countdown</span><FundingRate rate={ctx?.funding ?? null} running={!inZen()} separate />
    </button>
  {/if}
{/if}
{/snippet}

{#snippet marketSummary()}
<div class="market-summary" class:portrait-summary={portrait} data-testid="market-summary">
  <div class="selection">
    <button class="coin" data-testid="market-button" onclick={(e) => ((ui.overlay = 'picker'), e.currentTarget.blur())}>
      <Coin coin={market.coin} quote={quote} /> ▾
    </button>
    {#if !spot && instrument?.maxLeverage}
      <span class="max-leverage" data-testid="market-max-leverage" title="Maximum leverage for this market">{instrument.maxLeverage}x</span>
    {/if}
  </div>
  <div class="stat"><abbr class="dim help-label" title={markHelp}>Mark</abbr><span class="num" data-testid="mark">{ctx ? fmtPx(ctx.markPx, szDec, spot) : '—'}</span></div>
  {#if !spot}<div class="stat"><abbr class="dim help-label" title={oracleHelp}>Oracle</abbr><span class="num">{ctx?.oraclePx != null ? fmtPx(ctx.oraclePx, szDec) : '—'}</span></div>{/if}
  <div class="stat"><span class="dim">24h Change</span><span class="num" data-testid="day-change" class:buy={change >= 0} class:sell={change < 0}>{ctx ? `${dayMove} (${fmtPct(change)})` : '—'}</span></div>
  {@render more()}
  {@render fundingStat()}
  {#if !inZen() && !ui.chartFull}<ZenToggle />{/if}
</div>
{/snippet}
{#snippet pinnedMarkets()}
  <div class="desk-nav portrait-pins">{@render chipStrip()}</div>
{/snippet}

{#snippet header()}
{#if phone.current}
  <header class="bar">
    <img class="logo" src="/icon-192.png" alt="" width="24" height="24" />
    {@render chipStrip()}
    <span class="spacer"></span>
    {#if session.master}<AccountSwitch compact />{:else}<button class="connect" data-testid="top-connect" onclick={(e) => (e.currentTarget.blur(), toAccountTab())}>Connect</button>{/if}
    <button data-testid="settings-button" aria-label="settings" title="Settings (hotkeys, sizes)" onclick={(e) => (e.currentTarget.blur(), openSettings('execution'))}>⚙</button>
    <span class="sock" data-testid="top-socket" data-state={socket.state} title="socket {socket.state}"><i class:ok={socket.state === 'open'}></i></span>
  </header>
  <section class="ticker" data-testid="ticker">
    <button class="coin" data-testid="market-button" onclick={(e) => ((ui.overlay = 'picker'), e.currentTarget.blur())}>
      <span class="name"><Coin coin={market.coin} quote={quoteOf(market.coin)} /> ▾</span>
      {#if !spot && instrument?.maxLeverage}<span class="lev">{instrument.maxLeverage}x</span>{/if}
    </button>
    <div class="price">
      <span class="num big" data-testid="mark">{ctx ? fmtPx(ctx.markPx, szDec, spot) : '—'}</span>
      <span class="num day" data-testid="day-change" class:buy={change >= 0} class:sell={change < 0}>{ctx ? `${dayMove} / ${fmtPct(change)}` : '—'}</span>
    </div>
    {@render quickOpen()}
    <button class="more" data-testid="ticker-more" aria-expanded={statsOpen} aria-label={statsOpen ? 'Hide market stats' : 'Show market stats'} onclick={(e) => (e.currentTarget.blur(), (statsOpen = !statsOpen))}>{statsOpen ? '▴' : '▾'}</button>
    {#if statsOpen}
      <div class="stats" data-testid="ticker-stats">
        {#if !spot}<div class="stat"><span class="dim">Oracle</span><span class="num">{ctx?.oraclePx != null ? fmtPx(ctx.oraclePx, szDec) : '—'}</span></div>{/if}
        {@render more()}
        {@render fundingStat()}
      </div>
    {/if}
  </section>
{:else}
  <header class="desk" class:portrait>
    <div class="desk-nav">
      {#if !portrait}{@render chipStrip()}{/if}
      {@render desktopControls()}
    </div>
    {#if !portrait}{@render marketSummary()}{/if}
  </header>
{/if}
{#if suggestMigration}
  <aside class="migration-suggestion" data-testid="migration-suggestion" aria-label="Hyperliquid settings migration">
    <span>Coming from Hyperliquid?{#if !phone.current} Your settings are still at their defaults. Move your markets, chart and preferences with your local AI.{/if}</span>
    <button onclick={() => { dismissMigration(); ui.overlay = 'migration'; }}>Migration guide</button>
    <button aria-label="Dismiss migration suggestion" onclick={dismissMigration}>×</button>
  </aside>
{/if}
{/snippet}

{@render children(header, pinnedMarkets, marketSummary)}

<style>
  .migration-suggestion { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--surface); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .migration-suggestion > span { flex: 1 1 240px; }
  @media (max-width: 900px) { .migration-suggestion { flex-wrap: nowrap; padding: 4px 12px; } .migration-suggestion > span { flex: 1 1 auto; } }
  header { border-bottom: 1px solid var(--line); overflow: clip; white-space: nowrap; }
  .desk-nav, .market-summary, .bar { display: flex; align-items: center; }
  .desk-nav { padding: calc(4px + env(safe-area-inset-top)) 12px 4px; border-bottom: 1px solid var(--line); }
  .portrait .desk-nav { border-bottom: 0; }
  .portrait-pins { padding-block: 2px 3px; }
  .market-summary { flex-wrap: wrap; gap: 5px clamp(12px, 2.1vw, 32px); padding: 8px 12px; background: var(--panel); }
  .selection { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .selection .coin { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .max-leverage { padding: 1px 5px; border-radius: var(--radius); background: var(--surface); color: var(--accent); }
  .help-label { text-decoration: underline dashed var(--faint); text-underline-offset: 3px; }
  .funding-history { background: none; padding: 0; align-items: start; text-align: left; }
  .funding-history:hover > .dim { color: var(--bright); }
  .market-summary > :global(.zen-toggle) { margin-inline-start: auto; }
  .portrait-summary { gap: 4px clamp(8px, 1vw, 16px); padding-block: 4px; }
  .quick-strip { display: flex; align-items: center; min-width: 0; }
  .chips { min-width: 0; overflow-x: auto; scrollbar-width: none; font-size: max(8px, calc(var(--fs) * 0.917)); }
  .chip-track { display: flex; width: max-content; gap: 2px; padding: 4px 3px; }
  .scroll { flex: none; align-self: stretch; min-width: 24px; padding: 0 4px; background: none; color: var(--text); font-size: 1.3em; }
  .scroll:hover:enabled { background: var(--surface); color: var(--bright); }
  .scroll:disabled { color: var(--faint); }
  .coin { font-weight: 600; font-size: calc(var(--fs) * 1.167); background: none; padding: 4px 0; color: var(--bright); }
  .stat { display: flex; flex-direction: column; line-height: 1.35; font-size: max(8px, calc(var(--fs) * 0.917)); }
  .chip { display: flex; gap: 4px; align-items: baseline; padding: 4px 6px; background: none; color: var(--dim); }
  .chip[aria-current='true'] { background: var(--surface); color: var(--bright); }
  .chip .coin { font-weight: 600; }
  .slot { position: relative; display: flex; }
  .slot:hover, .slot:focus-within { z-index: 1; }
  .unchip { display: none; position: absolute; top: -4px; right: -2px; width: 16px; height: 16px; padding: 0; line-height: 14px; text-align: center; font-size: max(8px, calc(var(--fs) * 0.75)); background: var(--panel); color: var(--dim); border: 1px solid var(--line); border-radius: var(--radius); }
  .slot:hover .unchip, .slot:focus-within .unchip { display: block; }
  .unchip:hover { color: var(--sell); }
  .quick { background: none; color: var(--faint); padding: 4px; font-size: max(8px, calc(var(--fs) * 0.833)); margin-left: 6px; }
  .quick:hover { color: var(--warn); }
  .right { display: flex; gap: 8px; align-items: center; flex-shrink: 0; margin-left: auto; padding-left: 20px; }
  .bar { gap: 6px; padding: calc(6px + env(safe-area-inset-top)) 10px 6px; overflow: visible; }
  .bar > :not(.quick-strip, .spacer) { flex-shrink: 0; }
  .bar .logo { border-radius: var(--radius); }
  .bar [data-testid='settings-button'] { background: none; border: 1px solid var(--line); border-radius: var(--radius); font-size: calc(var(--fs) * 1.333); }
  .spacer { flex: 1 0 0; }
  .bar .chip[aria-current='true'] { background: none; }
  .bar .chip[aria-current='true'] .coin { color: var(--accent); }
  .connect { background: var(--accent); color: var(--bg); font-weight: 600; padding: 6px 14px; border-radius: var(--radius); }
  .ticker { display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: 2px 14px; padding: 6px 10px; border-bottom: 1px solid var(--line); }
  .ticker .coin { display: flex; flex-direction: column; align-items: flex-start; padding: 0; font-size: calc(var(--fs) * 1.5); }
  .ticker .lev { font-size: max(8px, calc(var(--fs) * 0.917)); font-weight: 400; color: var(--accent); }
  .price { display: flex; flex-direction: column; min-width: 0; font-size: max(8px, calc(var(--fs) * 0.917)); }
  .price .big { font-size: calc(var(--fs) * 1.5); color: var(--bright); }
  .ticker .quick { margin: 0 -10px 0 0; min-width: 36px; min-height: 36px; padding: 0 2px; border: 1px solid var(--line); border-radius: var(--radius); letter-spacing: -1px; }
  .more { background: none; border: 1px solid var(--line); border-radius: var(--radius); color: var(--dim); }
  .stats { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 14px; padding: 6px 0 2px; }
  .stats .stat { line-height: 1.3; }
  .sock { display: flex; align-items: center; padding: 0 2px; }
  .sock i { display: inline-block; width: 8px; height: 8px; border-radius: var(--radius); background: var(--sell); }
  .sock i.ok { background: var(--buy); }
</style>
