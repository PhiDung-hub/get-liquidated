<script module lang="ts">
  type Inline = { kind: 'text' | 'code' | 'strong' | 'num'; text: string };
  type Block = { gap: boolean } & ({ kind: 'pre'; text: string } | { kind: 'line'; marker: string; parts: Inline[] });

  const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const NUM = /(^|[^\w.])([-+−]?\$?\d+(?:,\d{3})*(?:\.\d+)?(?:%|bps|[kKmMbBx×smhdw])?)(?!\w)/g;
  const numbers = (text: string): Inline[] => text.split(NUM).flatMap((part, i): Inline[] => (!part ? [] : [{ kind: i % 3 === 2 ? 'num' : 'text', text: part }]));

  function inline(text: string): Inline[] {
    const out: Inline[] = [];
    let from = 0;
    for (const m of text.matchAll(/`([^`]+)`|\*\*([^*]+)\*\*/g)) {
      out.push(...numbers(text.slice(from, m.index)), m[1] !== undefined ? { kind: 'code', text: m[1] } : { kind: 'strong', text: m[2] });
      from = m.index + m[0].length;
    }
    return [...out, ...numbers(text.slice(from))];
  }

  function line(raw: string, gap: boolean): Block {
    const bullet = /^\s*(?:[-*]|(\d+\.))\s+(.*)$/.exec(raw);
    if (bullet) return { kind: 'line', gap, marker: bullet[1] ?? '•', parts: inline(bullet[2]) };
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(raw);
    if (heading) return { kind: 'line', gap, marker: '', parts: [{ kind: 'strong', text: heading[1].replaceAll('**', '') }] };
    const lead = /^([A-Z][\w /&-]{0,23}:)(?=\s|$)/.exec(raw);
    return { kind: 'line', gap, marker: '', parts: lead ? [{ kind: 'strong', text: lead[1] }, ...inline(raw.slice(lead[1].length))] : inline(raw) };
  }

  /** AI text as plain nodes: fenced blocks, backtick spans, **bold**, bullets, headings, "Label:" lead-ins and tinted numbers only, so nothing it writes becomes a link, an image or markup. */
  function blocks(text: string): Block[] {
    const out: Block[] = [];
    let gap = false;
    const add = (block: Block) => void (out.push(block), (gap = false));
    text.split(/```(?:[^\n`]*\n)?([\s\S]*?)```/).forEach((chunk, i) => {
      if (i % 2) return add({ kind: 'pre', gap, text: chunk.replace(/\n$/, '') });
      // A chunk's first and last pieces are the rest of a fence's line, never a blank line.
      chunk.split('\n').forEach((raw, j, all) => (raw.trim() ? add(line(raw, gap)) : (gap ||= out.length > 0 && j > 0 && j < all.length - 1)));
    });
    return out;
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  let { at, ai = false, text, testid, children }: { at: number; ai?: boolean; text: string; testid?: string; children?: Snippet } = $props();
</script>

<div class="msg" class:ai data-testid="ai-msg" data-role={ai ? 'assistant' : 'user'}>
  <time datetime={new Date(at).toISOString()}>{clock(at)}</time>
  <span class="glyph" aria-hidden="true">{ai ? '●' : '❯'}</span>
  <div class="body">
    {#if ai}
      <div class="text" data-testid={testid}>
        {#each blocks(text) as b}
          {#if b.kind === 'pre'}<pre class:gap={b.gap}><code>{b.text}</code></pre>
          {:else}<div class="ln" class:gap={b.gap} class:li={!!b.marker}>{#if b.marker}<span class="mk">{b.marker}</span>{/if}<span>{#each b.parts as p}{#if p.kind === 'code'}<code>{p.text}</code>{:else if p.kind === 'strong'}<strong>{p.text}</strong>{:else if p.kind === 'num'}<span class="num">{p.text}</span>{:else}{p.text}{/if}{/each}</span></div>{/if}
        {/each}
      </div>
    {:else}<p class="text" data-testid={testid}>{text}</p>{/if}
    {@render children?.()}
  </div>
</div>

<style>
  .msg { align-self: stretch; display: grid; grid-template-columns: auto auto minmax(0, 1fr); column-gap: 1ch; align-items: baseline; min-width: 0; }
  time, .glyph { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  time { color: var(--dim); font-size: max(8px, 0.917em); }
  .glyph, .mk, .num { color: var(--accent); }
  .ai .glyph { color: var(--buy); }
  .body { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
  .text { margin: 0; max-width: 100%; line-height: 1.5; }
  p.text { white-space: pre-wrap; }
  .ai .text { color: var(--bright); }
  .gap { margin-top: 0.6em; }
  .li { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 1ch; }
  .mk { font-family: var(--mono); }
  strong { font-weight: 700; }
  code, pre { font-family: var(--mono); }
  pre { margin: 4px 0; white-space: pre-wrap; }
  pre.gap { margin-top: 0.6em; }
</style>
