<script module lang="ts">
  type Num = { n: number; tol: number };
  type Inline = { kind: 'text' | 'code' | 'strong' | 'num'; text: string; num?: Num | null };
  type Levels = (number | null | undefined)[];
  type Block = { gap: boolean } & ({ kind: 'pre'; text: string } | { kind: 'line'; marker: string; parts: Inline[] });

  const clock = (t: number) => !t ? '--:--' : new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const NUM = /(^|[^\w.])([-+−]?\$?\d+(?:,\d{3})*(?:\.\d+)?(?:%|bps|[kKmMbBx×smhdw])?)(?!\w)/g;
  const SCALE: Record<string, number> = { k: 1e3, K: 1e3, M: 1e6, b: 1e9, B: 1e9 };
  /** A written number as a price with half its last written digit; null for a percentage, a multiple or a time span. */
  function value(text: string): Num | null {
    const m = /^[-+−]?\$?(\d+(?:,\d{3})*)(\.\d+)?([kK]|M|[bB])?$/.exec(text);
    if (!m) return null;
    const scale = SCALE[m[3]] ?? 1;
    return { n: Number(m[1].replaceAll(',', '') + (m[2] ?? '')) * scale, tol: 0.5 * scale * 10 ** (1 - (m[2]?.length ?? 1)) };
  }
  const numbers = (text: string): Inline[] => text.split(NUM).flatMap((part, i): Inline[] => (!part ? [] : i % 3 === 2 ? [{ kind: 'num', text: part, num: value(part) }] : [{ kind: 'text', text: part }]));
  const real = (levels: Levels) => levels.filter((n): n is number => typeof n === 'number' && n > 0);
  /** A written number is a level when the level rounds to it as written, and never further than 0.2% away. */
  const near = (num: Num, levels: number[]) => levels.some((level) => Math.abs(num.n - level) <= Math.min(num.tol, level * 0.002) + 1e-9);

  /** What a detail (a mark, a ticket, advice) and the numbers in AI text point at each other with: the levels of the detail under the pointer or focus, or the number under the pointer. */
  const linked = $state({ levels: [] as number[], num: null as Num | null });
  export const levelsIn = (...texts: (string | null | undefined)[]) => texts.flatMap((text) => [...(text ?? '').matchAll(NUM)].flatMap((m) => value(m[2])?.n ?? []));
  export const refers = (levels: Levels) => !!linked.num && near(linked.num, real(levels));
  /** Attached to a detail: hovering or focusing it lights the numbers in AI text equal to its levels. */
  export const detail = (levels: () => Levels) => (el: HTMLElement) => {
    const off = new AbortController();
    const set = (on: boolean) => () => (linked.levels = on ? real(levels()) : []);
    for (const [name, on] of [['pointerenter', true], ['focusin', true], ['pointerleave', false], ['focusout', false]] as const) el.addEventListener(name, set(on), { signal: off.signal });
    return () => off.abort();
  };

  const GLYPH = { user: '❯', assistant: '•', system: '·', term: '', mark: '◆', ticket: '▸', advice: '✦' };
  const KIND = { user: 'Your message', assistant: 'AI answer', system: 'Session note', term: 'Terminal session: your prompt and its reply', mark: 'Chart mark (mark tool)', ticket: 'Staged ticket (suggest tool)', advice: 'Advice (record_observation tool)' };

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
  let { at, ai = false, system = false, kind, text, reasoning, testid, children }: { at: number; ai?: boolean; system?: boolean; kind?: 'term' | 'mark' | 'ticket' | 'advice'; text?: string; reasoning?: string; testid?: string; children?: Snippet } = $props();
  const role = $derived(system ? 'system' : ai ? 'assistant' : 'user');
</script>

<div class="msg" data-testid="ai-msg" data-role={role} data-kind={kind ?? role}>
  <time datetime={new Date(at).toISOString()}>{clock(at)}</time>
  <span class="glyph" aria-hidden="true" title={KIND[kind ?? role]}>{(kind && GLYPH[kind]) || GLYPH[role]}</span>
  <div class="body">
    {#if text !== undefined && ai}
      <div class="text" data-testid={testid}>
        {#each blocks(text) as b}
          {#if b.kind === 'pre'}<pre class:gap={b.gap}><code>{b.text}</code></pre>
          {:else}<div class="ln" class:gap={b.gap} class:li={!!b.marker}>{#if b.marker}<span class="mk">{b.marker}</span>{/if}<span>{#each b.parts as p}{#if p.kind === 'code'}<code>{p.text}</code>{:else if p.kind === 'strong'}<strong>{p.text}</strong>{:else if p.kind === 'num'}{@const num = p.num}<span class="num" class:hit={!!num && near(num, linked.levels)} role="presentation" onpointerenter={() => (linked.num = num ?? null)} onpointerleave={() => (linked.num = null)}>{p.text}</span>{:else}{p.text}{/if}{/each}</span></div>{/if}
        {/each}
      </div>
    {:else if text !== undefined}<p class="text" data-testid={system ? 'ai-system' : testid}>{text}</p>{/if}
    {#if reasoning}<p class="text ai-why" data-testid="ai-reasoning" title="A short summary the AI chose to publish, not its private reasoning">{reasoning}</p>{/if}
    {@render children?.()}
  </div>
</div>

<style>
  .msg { align-self: stretch; display: grid; grid-template-columns: auto 1.2em minmax(0, 1fr); column-gap: 1ch; align-items: baseline; min-width: 0; }
  time, .glyph { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  time { color: var(--dim); font-size: max(8px, 0.917em); }
  .glyph { text-align: center; color: var(--bright); cursor: default; }
  .num { font-variant-numeric: tabular-nums; }
  .hit { color: var(--accent); }
  [data-kind='assistant'] > .glyph { color: var(--accent); }
  [data-kind='term'] > .glyph { color: var(--ai-term); }
  [data-kind='mark'] > .glyph { color: var(--ai-mark); }
  [data-kind='ticket'] > .glyph { color: var(--ai-ticket); }
  [data-kind='advice'] > .glyph { color: var(--ai-advice); }
  [data-kind='system'] > .glyph, [data-kind='system'] .text { color: var(--dim); }
  .body { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
  .text { margin: 0; max-width: 100%; line-height: 1.5; }
  p.text { white-space: pre-wrap; }
  .gap { margin-top: 0.6em; }
  .li { display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: 1ch; }
  .mk { color: var(--dim); font-family: var(--mono); }
  strong { font-weight: 600; color: var(--bright); }
  code, pre { font-family: var(--mono); }
  pre { margin: 4px 0; white-space: pre-wrap; }
  pre.gap { margin-top: 0.6em; }
</style>
