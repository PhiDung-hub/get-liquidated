<script module lang="ts">
  import { settings } from '$lib/settings/settings.svelte';

  type Sound = 'ouch' | 'liquidated' | 'yay' | 'yay-big';
  let unlocked = false;
  let audio: AudioContext | undefined;
  const clips = new Map<Sound, AudioBuffer>();
  // Measured MP3 loudness to −18 LUFS; attenuation only, preserving the CC0 recordings without another lossy encode.
  const levels: Record<Sound, number> = { ouch: 0.827, yay: 0.837, 'yay-big': 0.663, liquidated: 0.664 };
  let voice: { source: AudioBufferSourceNode; gain: GainNode } | undefined;
  let fading: typeof voice;

  function prepareAudio() {
    if (audio || !window.AudioContext) return;
    let ctx: AudioContext;
    try { ctx = audio = new AudioContext({ latencyHint: 'interactive' }); }
    catch (e) { console.warn('Effect audio unavailable', e); return; }
    if (!unlocked) void ctx.suspend().catch((e) => console.warn('Effect audio could not suspend', e));
    for (const s of Object.keys(levels) as Sound[]) {
      void fetch(`/sounds/${s}.mp3`)
        .then((r) => { if (!r.ok) throw new Error(`${r.status}`); return r.arrayBuffer(); })
        .then((data) => ctx.decodeAudioData(data))
        .then((buffer) => { if (audio === ctx) clips.set(s, buffer); })
        .catch((e) => { if (audio === ctx) console.warn(`Effect sound ${s} unavailable`, e); });
    }
  }

  function unlock() {
    unlocked = true;
    if (!settings.display.lol || document.visibilityState !== 'visible') return;
    prepareAudio();
    if (audio?.state === 'suspended') void audio.resume().catch((e) => console.warn('Effect audio could not resume', e));
  }

  function stopSound() {
    fading?.source.stop();
    voice?.source.stop();
    voice = fading = undefined;
  }

  export function play(s: Sound) {
    const buffer = clips.get(s);
    if (!unlocked || !settings.display.lol || document.visibilityState !== 'visible' || audio?.state !== 'running' || !buffer) return;
    const now = audio.currentTime;
    fading?.source.stop();
    if (voice) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + 0.008);
      voice.source.stop(now + 0.008);
    }
    fading = voice;
    const source = audio.createBufferSource(), gain = audio.createGain();
    source.buffer = buffer;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(levels[s] * 0.65, now + 0.004);
    source.connect(gain).connect(audio.destination);
    voice = { source, gain };
    source.onended = () => { source.disconnect(); gain.disconnect(); if (voice?.source === source) voice = undefined; };
    source.start();
  }

  function closeAudio() {
    stopSound();
    clips.clear();
    void audio?.close();
    audio = undefined;
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { liveFills, netPnl, type Fill } from '$lib/account/fills.svelte';
  import { inventory } from '$lib/account/inventory.svelte';
  import { isSpot, symOf } from '$lib/market/meta.svelte';
  import { session, viewAddress } from '$lib/session/session.svelte';
  import { fmtPct, fmtUsd } from '$lib/util/format';
  import { ui } from './state.svelte';
  import { menus } from './order/Menu.svelte';
  import Pepe from './Pepe.svelte';

  const SETTLE_MS = 16, GROUP_MS = 1500, LIQ_GROUP_MS = 2000, LIQ_MS = 8000, WIN_MS = 6000, BIG_WIN = 0.2;
  const still = new MediaQuery('prefers-reduced-motion: reduce');

  interface Burst { id: number; kind: 'profit' | 'loss' | 'liq'; text: string; sub: string; coins: { x: number; d: number; s: number; r: number }[] }
  type Popup = { kind: 'liq'; fills: Fill[] } | { kind: 'win'; coin: string; pnl: number; roe: number };
  let bursts = $state<Burst[]>([]);
  let popup = $state<Popup | null>(null);
  let box = $state<HTMLElement>();
  let next = 1, lastLiq = 0, popupTimer: ReturnType<typeof setTimeout> | undefined;
  let recent: Fill[] = [];
  const settling = new Map<string, ReturnType<typeof setTimeout>>();
  /** Each coin's leverage from its last position seen, which a full close's push may already have removed. */
  const levs = new Map<string, number>();

  const sum = (fs: Fill[]) => fs.reduce((s, f) => s + netPnl(f), 0);
  const signed = (n: number) => `${n >= 0 ? '+' : ''}${fmtUsd(n)}`;
  const reduces = (f: Fill) => !!f.startPosition && (f.startPosition > 0 ? f.side === 'A' : f.side === 'B');
  const flattens = (f: Fill) => reduces(f) && Math.abs(Math.abs(f.startPosition!) - f.sz) <= 1e-9 * Math.max(1, f.sz);
  const flips = (f: Fill) => reduces(f) && f.sz - Math.abs(f.startPosition!) > 1e-9 * Math.max(1, f.sz);
  /** Net PnL over the margin the closed size used: each fill's entry is its price less (long) or plus (short) closedPnl per unit; 1× with no known position. */
  const roe = (group: Fill[], net: number) => {
    const ntl = group.reduce((t, f) => t + f.sz * f.px + (f.side === 'A' ? -f.closedPnl : f.closedPnl), 0);
    return ntl > 0 ? (net * (levs.get(group[0].coin) ?? 1)) / ntl : 0;
  };

  function burst(kind: Burst['kind'], text: string, sub: string, ms: number) {
    const id = next++;
    const coins = kind === 'profit' && !still.current ? Array.from({ length: 18 }, () => ({ x: Math.random() * 100, d: Math.random() * 0.5, s: 0.9 + Math.random() * 0.7, r: Math.random() * 720 - 360 })) : [];
    bursts = [...bursts, { id, kind, text, sub, coins }];
    setTimeout(() => (bursts = bursts.filter((b) => b.id !== id)), ms);
  }

  function show(p: Popup, ms: number) {
    popup = p;
    clearTimeout(popupTimer);
    popupTimer = setTimeout(closePopup, ms);
  }

  function closePopup() {
    clearTimeout(popupTimer);
    popup = null;
  }

  function settle(last: Fill) {
    settling.delete(last.coin);
    if (document.visibilityState !== 'visible') return;
    const mine = recent.filter((f) => f.coin === last.coin);
    const closed = mine.slice(0, mine.indexOf(last) + 1);
    const group = closed.filter((f) => f.oid === last.oid || Math.abs(f.time - last.time) <= GROUP_MS);
    recent = recent.filter((f) => !closed.includes(f));
    if (!group.length || group.some((f) => f.liquidation)) return;
    const net = sum(group), r = roe(group, net), big = net > 0 && r >= BIG_WIN, pop = big && popup?.kind !== 'liq';
    // A big win's popup carries its numbers; its burst only rains coins.
    burst(net >= 0 ? 'profit' : 'loss', pop ? '' : signed(net), pop ? '' : `${symOf(last.coin)} closed`, 2000);
    if (pop) show({ kind: 'win', coin: last.coin, pnl: net, roe: r }, WIN_MS);
    play(net < 0 ? 'ouch' : big ? 'yay-big' : 'yay');
  }

  function liquidated(fs: Fill[]) {
    const now = Date.now(), same = now - lastLiq < LIQ_GROUP_MS;
    const open = popup?.kind === 'liq' ? popup.fills : null;
    lastLiq = now;
    if (!same) burst('liq', 'LIQUIDATED', '', 1500);
    show({ kind: 'liq', fills: [...(same && open ? open : []), ...fs] }, LIQ_MS);
    if (!same) play('liquidated');
  }

  function onFills(fs: Fill[]) {
    if (!settings.display.lol || document.visibilityState !== 'visible' || !session.master) return;
    const perp = fs.filter((f) => !isSpot(f.coin));
    // A position's reduce fills are kept until it goes flat; a flip's closedPnl is the old position's.
    for (const f of perp.filter(reduces)) recent = flips(f) ? recent.filter((r) => r.coin !== f.coin) : [...recent, f];
    const liq = perp.filter((f) => f.liquidation);
    if (liq.length) liquidated(liq);
    for (const f of perp.filter(flattens)) {
      clearTimeout(settling.get(f.coin));
      settling.set(f.coin, setTimeout(() => settle(f), SETTLE_MS));
    }
  }

  /** Per coin: its net loss in the liquidation popup. */
  const lines = $derived.by(() => {
    const by = new Map<string, number>();
    for (const f of popup?.kind === 'liq' ? popup.fills : []) by.set(f.coin, (by.get(f.coin) ?? 0) + netPnl(f));
    return [...by];
  });

  function visibility() {
    if (document.visibilityState === 'visible') { if (unlocked) unlock(); return; }
    stopSound();
    settling.forEach(clearTimeout);
    settling.clear();
    recent = [];
    bursts = [];
    closePopup();
    if (audio?.state === 'running') void audio.suspend().catch((e) => console.warn('Effect audio could not suspend', e));
  }

  function onKey(e: KeyboardEvent) {
    unlock();
    if (e.key !== 'Escape' || !popup || ui.overlay || menus.open) return;
    e.preventDefault();
    e.stopPropagation();
    closePopup();
  }
  function onPointer(e: PointerEvent) {
    unlock();
    if (popup && !box?.contains(e.target as Node)) closePopup();
  }

  $effect(() => {
    if (settings.display.lol) prepareAudio();
    else stopSound();
  });

  const images = new Map<string, HTMLImageElement>();
  $effect(() => {
    const suffix = still.current ? '-still.webp' : '.webp';
    const paths = [
      settings.display.lol && `/big-win${suffix}`,
      settings.display.lol && `/liquidated-${settings.display.theme === 'paper' ? 'light' : 'dark'}${suffix}`
    ].filter(Boolean) as string[];
    const warm = () => {
      for (const path of paths) {
        if (images.has(path)) continue;
        const img = new Image();
        images.set(path, img);
        img.src = path;
        void img.decode().catch((e) => console.warn(`Effect image ${path} unavailable`, e));
      }
    };
    const id = setTimeout(warm, 5000);
    return () => clearTimeout(id);
  });

  $effect(() => {
    for (const p of inventory.positions) levs.set(p.coin, p.leverage.value);
  });

  $effect(() => {
    void viewAddress();
    return () => {
      settling.forEach(clearTimeout);
      settling.clear();
      levs.clear();
      recent = [];
      stopSound();
      closePopup();
    };
  });

  onMount(() => {
    const off = liveFills.on(onFills);
    addEventListener('keydown', onKey, true);
    addEventListener('pointerdown', onPointer, true);
    addEventListener('pointerup', unlock, true);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      off();
      removeEventListener('keydown', onKey, true);
      removeEventListener('pointerdown', onPointer, true);
      removeEventListener('pointerup', unlock, true);
      document.removeEventListener('visibilitychange', visibility);
      closePopup();
      images.clear();
      closeAudio();
    };
  });
</script>

{#if bursts.length}
  <div class="fx" class:still={still.current} aria-hidden="true">
    {#each bursts as b, i (b.id)}
      <div class="burst {b.kind}" data-testid="fx-{b.kind === 'liq' ? 'liq' : 'close'}" data-kind={b.kind}>
        {#if b.kind === 'liq'}<div class="flash" data-testid="fx-flash"></div>{:else if b.kind === 'loss'}<div class="vignette" data-testid="fx-vignette"></div>{/if}
        {#each b.coins as c, j (j)}<i class="coin" style:left="{c.x}%" style:animation-delay="{c.d}s" style:animation-duration="{c.s}s" style:--r="{c.r}deg"></i>{/each}
        {#if b.text}
          <div class="text" style:top="calc(38% + {i * 64}px)">
            <b data-testid="fx-text">{b.text}</b>
            {#if b.sub}<span>{b.sub}</span>{/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

{#if popup}
  <div bind:this={box} class="popup {popup.kind}" role="status" aria-live="polite" data-testid="{popup.kind}-popup">
    <button class="x" aria-label="Close" tabindex="-1" data-testid="{popup.kind}-popup-close" onpointerdown={(e) => e.preventDefault()} onclick={closePopup}>✕</button>
    <Pepe kind={popup.kind} />
    {#if popup.kind === 'liq'}
      <b class="title">LIQUIDATED</b>
      {#each lines as [coin, pnl] (coin)}
        <div class="line" data-testid="liq-popup-line"><span class="sym">{symOf(coin)}</span> <b class="big num">{fmtUsd(pnl)}</b></div>
      {/each}
      {#if lines.length > 1}<div class="line total" data-testid="liq-popup-pnl"><span class="sym">Total</span> <b class="big num">{fmtUsd(sum(popup.fills))}</b></div>{/if}
    {:else}
      <b class="title">BIG WIN</b>
      <div class="line" data-testid="win-popup-line"><span class="sym">{symOf(popup.coin)}</span> <b class="big num" data-testid="win-popup-roe">{fmtPct(popup.roe, 1)}</b></div>
      <span class="num gain" data-testid="win-popup-pnl">{signed(popup.pnl)}</span>
    {/if}
  </div>
{/if}

<style>
  .fx { position: fixed; inset: 0; z-index: 40; pointer-events: none; overflow: hidden; --ink: color-mix(in srgb, var(--sell) 30%, #000); --stamp: color-mix(in srgb, var(--sell) 72%, #4a0010); }
  :global(:root[data-theme='paper']) .fx { --ink: color-mix(in srgb, var(--sell) 30%, var(--bg)); --stamp: var(--sell); }
  .burst, .flash, .vignette { position: absolute; inset: 0; }
  .text { position: absolute; left: 0; right: 0; display: flex; flex-direction: column; align-items: center; gap: 2px; text-align: center; }
  .text b { font: 700 clamp(32px, 6vw, 64px)/1 var(--mono); letter-spacing: -0.02em; }
  .text span { color: var(--bright); font-weight: 600; font-size: calc(var(--fs) * 1.2); text-shadow: 0 1px 4px color-mix(in srgb, var(--bg) 80%, transparent); }
  .profit .text b { color: var(--buy); text-shadow: 0 0 18px color-mix(in srgb, var(--buy) 60%, transparent), 0 2px 6px color-mix(in srgb, var(--bg) 80%, transparent); animation: rise 2s ease-out forwards; }
  .loss .text b { color: var(--sell); text-shadow: 0 2px 6px color-mix(in srgb, var(--bg) 80%, transparent); animation: sink 1.8s ease-in forwards; }
  .liq .text b {
    color: var(--stamp); background: color-mix(in srgb, var(--bg) 72%, transparent); border: 4px double currentColor; padding: 4px 16px; border-radius: var(--radius); letter-spacing: 0.08em;
    text-shadow: 0 0 14px color-mix(in srgb, var(--sell) 45%, transparent); transform: rotate(-8deg); animation: stamp 1.5s cubic-bezier(.2, 1.6, .4, 1) forwards;
  }
  :global(:root[data-theme='paper']) .liq .text b { text-shadow: none; }
  .flash { background: radial-gradient(ellipse at center, color-mix(in srgb, var(--ink) 20%, transparent) 25%, color-mix(in srgb, var(--ink) 88%, transparent)); animation: flash 0.9s ease-out forwards; }
  .vignette { background: radial-gradient(ellipse at center, transparent 55%, color-mix(in srgb, var(--ink) 70%, transparent)); animation: fade 1.6s ease-out forwards; }
  .coin {
    position: absolute; top: -40px; width: 22px; height: 22px; border-radius: var(--radius);
    background: radial-gradient(circle at 35% 35%, #fff6c2, #f3c96b 45%, #b7862a 100%); box-shadow: inset 0 0 0 2px #a8781f;
    animation: fall 1.2s cubic-bezier(.4, 0, 1, 1) forwards; will-change: transform, opacity;
  }
  .still .text b, .still .flash, .still .vignette, .still .coin { animation: none; }
  .still .flash { opacity: 0.6; }
  @keyframes rise { 0% { transform: translateY(30px) scale(.6); opacity: 0; } 15% { transform: translateY(0) scale(1.08); opacity: 1; } 75% { opacity: 1; } 100% { transform: translateY(-70px) scale(1); opacity: 0; } }
  @keyframes sink { 0% { transform: translateY(-10px); opacity: 0; } 12% { transform: translateY(0); opacity: 1; } 20%, 30% { transform: translateX(-4px) rotate(-1deg); } 25%, 35% { transform: translateX(4px) rotate(1deg); } 70% { transform: translateY(8px); opacity: 1; } 100% { transform: translateY(60px) rotate(3deg); opacity: 0; } }
  @keyframes stamp { 0% { transform: scale(3) rotate(-20deg); opacity: 0; } 18% { transform: scale(1) rotate(-8deg); opacity: 1; } 22%, 34% { transform: translate(-6px, 3px) rotate(-9deg); } 28%, 40% { transform: translate(6px, -3px) rotate(-7deg); } 46% { transform: rotate(-8deg); } 80% { opacity: 1; } 100% { opacity: 0; } }
  @keyframes flash { 0% { opacity: 0; } 12% { opacity: 1; } 100% { opacity: 0; } }
  @keyframes fade { 0%, 100% { opacity: 0; } 25% { opacity: 1; } }
  @keyframes fall { 0% { transform: translateY(0) rotate(0); opacity: 1; } 85% { opacity: 1; } 100% { transform: translateY(105vh) rotate(var(--r)); opacity: 0; } }

  .popup {
    position: fixed; z-index: 9; top: 56px; left: 56px; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 10px 12px 12px; max-width: calc(100vw - 16px);
    background: var(--panel); color: var(--text); border: 1px solid color-mix(in srgb, var(--sell) 55%, var(--line)); border-radius: var(--radius);
    box-shadow: 0 8px 28px color-mix(in srgb, #000 55%, transparent); text-align: center; pointer-events: none;
  }
  .popup.win { border-color: color-mix(in srgb, var(--warn) 55%, var(--line)); }
  .title { margin-top: 6px; color: var(--sell-text); font-size: calc(var(--fs) * 1.15); letter-spacing: 0.12em; }
  .win .title { color: var(--warn); }
  .line { display: flex; align-items: baseline; justify-content: center; gap: 10px; }
  .sym { color: var(--bright); font-weight: 600; font-size: calc(var(--fs) * 1.25); }
  .big { color: var(--sell); font: 700 40px/1.1 var(--mono); letter-spacing: -0.02em; text-shadow: 0 0 16px color-mix(in srgb, var(--sell) 55%, #5a0010); }
  .total .big { font-size: 32px; }
  .win .big { color: var(--buy); text-shadow: 0 0 16px color-mix(in srgb, var(--warn) 55%, transparent); }
  .gain { color: var(--warn); font-weight: 600; font-size: calc(var(--fs) * 1.3); }
  :global(:root[data-theme='paper']) .big { text-shadow: none; }
  .x { position: absolute; top: 4px; right: 4px; z-index: 1; pointer-events: auto; background: color-mix(in srgb, var(--panel) 70%, transparent); color: var(--dim); padding: 2px 6px; }
  @media (max-width: 900px) {
    .popup { left: 50%; transform: translateX(-50%); }
    .liq .text { display: none; }
  }
</style>
