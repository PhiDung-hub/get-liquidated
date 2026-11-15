<script lang="ts">
  import { untrack, type Snippet } from 'svelte';

  let { label, short, value = $bindable(), testid, ariaLabel, placeholder, readonly = false, inputmode = 'decimal', suffix }: {
    label: string; short?: string; value: string; testid?: string; ariaLabel?: string; placeholder?: string; readonly?: boolean; inputmode?: 'decimal' | 'numeric'; suffix?: Snippet;
  } = $props();

  // A number still being typed ("-", "." or "1.") stays on screen while it reads as the value the parent kept; anything else the parent changed replaces it.
  const num = (t: string) => Number(/^\s*-?\.?\s*$/.test(t) ? 0 : t);
  const same = (typed: string, v: string) => typed === v || (/^\s*-?\d*\.?\d*\s*$/.test(typed) && num(typed) === num(v));
  let text = $state(untrack(() => value));
  $effect.pre(() => {
    const v = value;
    untrack(() => same(text, v) || (text = v));
  });
  function typed(e: Event & { currentTarget: HTMLInputElement }) {
    const t = e.currentTarget.value;
    value = t;
    text = same(t, value) ? t : value;
    if (e.currentTarget.value !== text) e.currentTarget.value = text;
  }

  let tight = $state(false);
  /** The full label stays laid out (transparent) while the short one is drawn over it, so the fit test never flips the layout it measures. */
  function fitLabel(el: HTMLElement) {
    void label;
    const ro = new ResizeObserver(() => (tight = el.scrollWidth > el.clientWidth));
    ro.observe(el);
    ro.observe(el.parentElement!);
    return () => ro.disconnect();
  }
</script>

<label class="ui-field field" class:readonly>
  <span class="label" class:tight data-short={short} {@attach short && fitLabel}>{label}</span>
  {#if readonly}
    <span class="value" data-testid={testid} aria-label={ariaLabel ?? label}>{value}</span>
  {:else}
    <input data-testid={testid} aria-label={ariaLabel ?? label} {inputmode} {placeholder} autocomplete="off" spellcheck="false" value={text} oninput={typed} />
  {/if}
  {#if suffix}<span class="suffix">{@render suffix()}</span>{/if}
</label>

<style>
  .field { display: flex; align-items: center; gap: 4px; height: var(--ctl); padding: 0 8px; color: var(--dim); }
  .label { text-align: left; white-space: nowrap; }
  input, .value { flex: 1; min-width: 0; text-align: right; color: var(--bright); font-variant-numeric: tabular-nums; }
  input { height: 100%; padding: 0; background: none; border: 0; border-radius: 0; outline: none; caret-color: var(--bright); }
  .suffix { display: inline-flex; align-items: center; align-self: stretch; color: var(--bright); white-space: nowrap; }
  @media (max-width: 900px) {
    .field { padding: 0 6px; }
    .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .label.tight { position: relative; color: transparent; }
    .label.tight::after { content: attr(data-short); position: absolute; top: 0; left: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; color: var(--dim); }
    input, .value { min-width: 3ch; }
  }
</style>
