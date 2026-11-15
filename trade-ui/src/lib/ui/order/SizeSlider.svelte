<script lang="ts">
  let { pct = $bindable(), onpct, id = 'panel' }: { pct: number; onpct: (v: number) => void; id?: string } = $props();

  const DOTS = [0, 25, 50, 75, 100];
  const KEYS: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10, Home: -100, End: 100 };
  let track = $state<HTMLDivElement>();
  let press = $state<number | null>(null);
  let dragging = false;
  let rect: DOMRect;

  /** `exact` re-applies an equal value: a size typed at 75% is not the same order as the 75% dot. */
  function set(v: number, exact = false) {
    const next = Math.min(100, Math.max(0, Math.round(v)));
    if (next === pct && !exact) return;
    pct = next;
    onpct(next);
  }

  const at = (e: PointerEvent) => set(((e.clientX - rect.left) / rect.width) * 100);

  /** A dot gives its exact value; anywhere else rounds the pointer position. preventDefault keeps a press from selecting or dragging page text, which cancels the pointer. */
  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    track!.setPointerCapture(e.pointerId);
    rect = track!.getBoundingClientRect();
    press = e.clientX;
    const dot = (e.target as HTMLElement).dataset.v;
    if (dot === undefined) at(e);
    else set(Number(dot), true);
  }

  /** Moves under 3px are a click, so a hand tremor on a dot keeps its exact value. */
  function move(e: PointerEvent) {
    if (press === null || (!dragging && Math.abs(e.clientX - press) < 3)) return;
    dragging = true;
    at(e);
  }

  function up() {
    if (press === null) return;
    press = null;
    dragging = false;
    (document.activeElement as HTMLElement | null)?.blur();
  }

  function key(e: KeyboardEvent) {
    const d = KEYS[e.key];
    if (d === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    set(pct + d);
  }

  /** Whole numbers 0–100: a key that would push past 100 (a third digit, mostly) is dropped. */
  function typed(e: Event & { currentTarget: HTMLInputElement }) {
    const el = e.currentTarget;
    const digits = el.value.replace(/\D/g, '');
    const n = Number(digits);
    if (n > 100) return void (el.value = String(pct));
    el.value = digits && String(n);
    set(n);
  }
</script>

<div class="slider">
  <div
    class="track"
    class:pressed={press !== null}
    role="slider"
    tabindex="0"
    aria-label="Size percent"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={pct}
    data-testid="{id}-slider"
    bind:this={track}
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onlostpointercapture={up}
    onkeydown={key}
  >
    <span class="fill" style:width="{pct}%"></span>
    {#each DOTS as d (d)}
      <span class="dot" class:on={d <= pct} data-v={d} style:left="{d}%"></span>
    {/each}
    <span class="knob" style:left="{pct}%"></span>
  </div>
  <label class="ui-field pct">
    <input data-testid="{id}-pct" inputmode="numeric" autocomplete="off" aria-label="Size percent box" value={pct} oninput={typed} />
    <span>%</span>
  </label>
</div>

<style>
  .slider { display: grid; grid-template-columns: 1fr minmax(calc(var(--fs) * 5), auto); gap: 10px; align-items: center; }
  .track { position: relative; height: 8px; margin: 0 9px; border-radius: var(--radius); background: var(--surface); cursor: pointer; touch-action: none; user-select: none; -webkit-user-select: none; outline: none; }
  .track::after { content: ''; position: absolute; inset: -8px -9px; }
  .fill { position: absolute; top: 0; bottom: 0; left: 0; border-radius: var(--radius); background: color-mix(in srgb, var(--accent) 15%, var(--bg)); }
  .dot { position: absolute; top: 50%; z-index: 1; width: 6px; height: 6px; border-radius: var(--radius); background: var(--faint); transform: translate(-50%, -50%); }
  .dot.on { background: var(--accent); }
  .knob { position: absolute; top: 50%; z-index: 2; width: 14px; height: 14px; border-radius: var(--radius); background: color-mix(in srgb, var(--accent) 15%, var(--bg)); border: 2px solid var(--accent); transform: translate(-50%, -50%); pointer-events: none; transition: box-shadow 0.2s; }
  .pressed .knob, .track:focus-visible .knob { box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 30%, transparent); }
  .pct { display: flex; align-items: center; gap: 4px; height: var(--ctl); padding: 0 12px 0 10px; color: var(--bright); }
  @media (max-width: 900px) {
    .track::after { inset: -12px -9px; }
  }
  .pct input { width: 20px; flex: 1; min-width: 3ch; padding: 0; background: none; border: 0; border-radius: 0; outline: none; text-align: left; font-variant-numeric: tabular-nums; }
</style>
