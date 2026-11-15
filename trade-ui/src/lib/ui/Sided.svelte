<script module lang="ts">
  import type { Side } from './toast.svelte';
  const WORD: Record<Side, RegExp> = { buy: /\b(buy|bid)\b/i, sell: /\b(sell|ask)\b/i };
</script>

<script lang="ts">
  /** Colours the first word of `side` in app-authored text; without a side the text stays plain. */
  let { text, side }: { text: string; side?: Side } = $props();
  const m = $derived(side ? WORD[side].exec(text) : null);
</script>

{#if m}{text.slice(0, m.index)}<span class={side}>{m[0]}</span>{text.slice(m.index + m[0].length)}{:else}{text}{/if}
