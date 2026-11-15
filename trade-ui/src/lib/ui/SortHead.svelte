<script lang="ts" generics="T">
  import type { Sorter } from './tables.svelte';
  const { sorter }: { sorter: Sorter<T> } = $props();
</script>

{#each sorter.columns as c (c.key)}
  {@const on = sorter.key === c.key}
  <th aria-sort={on ? (sorter.desc ? 'descending' : 'ascending') : 'none'} title={c.title}>
    <button class="sort" class:on onclick={(e) => (e.detail && e.currentTarget.blur(), sorter.toggle(c.key))}>{c.label}<span aria-hidden="true">{on ? (sorter.desc ? ' ↓' : ' ↑') : ''}</span></button>
  </th>
{/each}

<style>
  .sort { background: none; color: inherit; font: inherit; padding: 0; white-space: nowrap; }
  .sort:hover, .sort.on { color: var(--bright); }
  @media (max-width: 900px) { .sort { min-height: 32px; } }
</style>
