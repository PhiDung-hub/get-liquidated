<script lang="ts">
  import { settings } from '$lib/settings/settings.svelte';

  let { kind }: { kind: 'liq' | 'win' } = $props();

  type Eq = [text: string, x: number, y: number, size: number, rot: number, sup?: string, sub?: string];
  const EQS: Record<'liq' | 'win', Eq[]> = {
    liq: [
      ['liqPx = entry·(1 − 1/lev + mmr)', 8, 17, 12.5, -2], ['P(rekt) = 1', 238, 15, 11, 3], ['PnL = Δp × size', 10, 36, 11, 2], ['≈ 0', 282, 40, 16, 8],
      ['∂equity/∂t < 0', 4, 70, 10.5, -8], ['∫ hope dt', 6, 104, 13, -3], ['Σ losses', 8, 140, 12, 4], ['e', 14, 176, 16, 0, '−rt'], ['Δp < 0 ⇒ ☠', 4, 214, 10.5, 3],
      ['lim', 270, 74, 13, 0, undefined, 'lev→∞'], ['σ√t', 276, 120, 16, 8], ['100× ≠ edge', 258, 156, 10.5, -6], ['mmr ÷ lev', 262, 196, 10.5, 4]
    ],
    win: [
      ['ROE = PnL ÷ margin', 8, 17, 12.5, -2], ['≥ 20% ⇒ genius', 196, 18, 12.5, 3], ['Δp × size > 0', 10, 36, 11, 2], ['≈ ∞', 282, 42, 16, 8],
      ['∂equity/∂t > 0', 4, 70, 10.5, -8], ['∫ alpha dt', 6, 104, 13, -3], ['Σ wins', 10, 140, 13, 4], ['e', 14, 176, 16, 0, 'rt'],
      ['lim', 268, 74, 13, 0, undefined, 'skill→∞'], ['number', 264, 120, 12, 8], ['go up', 270, 134, 12, 8], ['100% ✓', 262, 176, 12, -6]
    ]
  };
  const art = $derived(kind === 'win' ? '/big-win' : `/liquidated-${settings.display.theme === 'paper' ? 'light' : 'dark'}`);
</script>

<div class="field {kind}" data-testid="pepe-field">
  <svg viewBox="0 0 320 236" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <radialGradient id="pepe-vg-{kind}" cx="50%" cy="58%" r="72%"><stop offset="52%" class="vig" stop-opacity="0" /><stop offset="100%" class="vig" /></radialGradient>
      <radialGradient id="pepe-glow" cx="50%" cy="62%" r="48%"><stop offset="0" class="glow" stop-opacity="0.38" /><stop offset="60%" class="glow2" stop-opacity="0.16" /><stop offset="100%" class="glow2" stop-opacity="0" /></radialGradient>
      <filter id="pepe-chalk" x="-5%" y="-20%" width="110%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves="1" seed="3" result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale="1.2" result="d" />
        <feComponentTransfer in="n" result="g"><feFuncA type="discrete" tableValues="0 1 1 1" /></feComponentTransfer>
        <feComposite in="d" in2="g" operator="in" />
      </filter>
    </defs>
    <rect class="ground" width="320" height="236" />
    {#if kind === 'win'}<rect width="320" height="236" fill="url(#pepe-glow)" />{/if}
    <g class="chalk" filter="url(#pepe-chalk)">
      {#each EQS[kind] as [t, x, y, size, rot, sup, sub], i (i)}
        <g>
          <text transform="translate({x} {y}) rotate({rot})" font-size={size}>{t}{#if sup}<tspan dy="-0.45em" font-size="0.65em">{sup}</tspan>{/if}{#if sub}<tspan x="0" dy="1.05em" font-size="0.62em">{sub}</tspan>{/if}</text>
        </g>
      {/each}
    </g>
    <rect width="320" height="236" fill="url(#pepe-vg-{kind})" />
  </svg>
  <picture>
    <source srcset="{art}-still.webp" media="(prefers-reduced-motion: reduce)" />
    <img src="{art}.webp" alt={kind === 'win' ? 'Pepe in sunglasses, money raining' : 'Pepe raging at his keyboard'} width="200" height="200" decoding="async" />
  </picture>
</div>

<style>
  .field { position: relative; width: 320px; max-width: 100%; height: 236px; overflow: hidden; border-radius: var(--radius); background: color-mix(in srgb, var(--bg) 90%, var(--text)); contain: paint; }
  svg { position: absolute; inset: 0; width: 100%; height: 100%; animation: drift 13s ease-in-out infinite alternate; will-change: transform; }
  .ground { fill: color-mix(in srgb, var(--bg) 90%, var(--text)); }
  .chalk { fill: var(--text); fill-opacity: 0.6; font-family: 'STIX Two Text', 'Liberation Serif', 'Times New Roman', serif; font-style: italic; }
  .vig { stop-color: color-mix(in srgb, var(--sell) 26%, #000); }
  .win .vig { stop-color: #000; }
  .glow { stop-color: var(--warn); }
  .glow2 { stop-color: var(--buy); }
  :global(:root[data-theme='paper']) .vig { stop-color: color-mix(in srgb, var(--sell) 22%, var(--bg)); }
  :global(:root[data-theme='paper']) .win .vig { stop-color: color-mix(in srgb, var(--warn) 25%, var(--bg)); }
  img { position: absolute; left: 50%; bottom: 0; width: 200px; height: 200px; transform: translateX(-50%); }
  @keyframes drift { from { transform: translate(-3px, 2px); } to { transform: translate(4px, -3px); } }
  @media (prefers-reduced-motion: reduce) { svg { animation: none; will-change: auto; } }
</style>
