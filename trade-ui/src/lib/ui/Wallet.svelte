<script module lang="ts">
  import { accounts, session } from '$lib/session/session.svelte';
  import { fmtAddr } from '$lib/util/format';
  import { toast } from './toast.svelte';

  export type Status = { id: 'trading' | 'enable' | 'readonly' | 'linked'; text: string };

  export function walletStatus(): Status | null {
    if (!session.master) return session.watch ? { id: 'readonly', text: 'read-only' } : null;
    if (session.linked) return { id: 'linked', text: 'linked phone' };
    if (!session.holdsSigner) return { id: 'readonly', text: 'read-only' };
    return session.agent ? { id: 'trading', text: 'trading' } : { id: 'enable', text: 'needs Enable trading' };
  }

  function pattern(address: string) {
    let h = 2166136261;
    for (let i = 0; i < address.length; i++) h = Math.imul(h ^ address.charCodeAt(i), 16777619);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = (h ^ (h >>> 12)) >>> 0;
    let d = '';
    for (let r = 0; r < 5; r++)
      for (let c = 0; c < 3; c++) if ((h >>> (9 + r * 3 + c)) & 1) d += `M${c} ${r}h1v1h-1z` + (c < 2 ? `M${4 - c} ${r}h1v1h-1z` : '');
    return { hue: h % 360, d };
  }

  /** execCommand covers an http origin or a browser that refuses the async clipboard. */
  async function write(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const back = document.activeElement as HTMLElement | null;
      const area = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
      area.style.cssText = 'position: fixed; opacity: 0';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      back?.focus();
      return ok;
    }
  }

  export { identicon, who };
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';

  let { address, children, text = false, copyable = true }: { address: string; children?: Snippet; text?: boolean; copyable?: boolean } = $props();
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function copy(e: MouseEvent & { currentTarget: HTMLButtonElement }) {
    e.stopPropagation();
    if (e.detail) e.currentTarget.blur();
    if (!(await write(address))) return toast.error(`Copy failed: select the address by hand, ${address}`);
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), 1500);
  }
</script>

{#snippet identicon(address: string, status = '')}
  {@const p = pattern(address)}
  <span class="id" data-status={status || undefined}>
    <svg viewBox="0 0 5 5" aria-hidden="true" shape-rendering="crispEdges">
      <rect width="5" height="5" fill="hsl({p.hue} 45% 34%)" />
      <path d={p.d} fill="hsl({(p.hue + 150) % 360} 80% 72%)" />
    </svg>
  </span>
{/snippet}

{#snippet who(address: string)}
  {@const s = walletStatus()}
  {@const name = accounts.list.find((a) => a.address === address)?.label}
  <span class="who" data-testid="wallet-static" title="{name ? `${name} ` : ''}{address}{s ? ` · ${s.text}` : ''}">
    {@render identicon(address, s?.id)}{#if name}<span class="label name">{name}</span>{/if}<span class="num addr">{fmtAddr(address)}</span>{#if s}<span class="label state" data-status={s.id}>{s.text}</span>{/if}
  </span>
{/snippet}

<span class="wallet" class:text style:--hue={pattern(address).hue}>
  {@render children?.()}
  {#if copyable}<button class="copy" data-testid="copy-address" data-copied={copied} aria-label={copied ? 'Copied' : `Copy address ${address}`} title={copied ? 'Copied' : `Copy ${address}`} onclick={copy}>
    {#if copied}
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.5 3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
    {:else}
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" fill="none" stroke="currentColor" stroke-width="1.4" /></svg>
    {/if}
    {#if text}<span>{copied ? 'Copied' : 'Copy'}</span>{/if}
  </button>{/if}
</span>

<style>
  .id { position: relative; display: inline-flex; flex-shrink: 0; width: 1.25em; height: 1.25em; vertical-align: -0.25em; }
  .id svg { width: 100%; height: 100%; border-radius: var(--radius); }
  .id[data-status]::after { content: ''; position: absolute; right: -3px; bottom: -3px; width: 7px; height: 7px; border-radius: var(--radius); background: var(--dim); box-shadow: 0 0 0 2px var(--tint, var(--bg)); }
  .id[data-status='trading']::after { background: var(--buy); }
  .id[data-status='enable']::after { background: var(--warn); }
  .id[data-status='linked']::after { background: var(--buy); }
  .wallet { display: inline-flex; align-items: stretch; gap: 2px; min-width: 0; --tint: var(--surface); }
  @supports (color: oklch(from red l c h)) { .wallet { --tint: oklch(from var(--surface) l 0.05 var(--hue)); } }
  .wallet > :global(:first-child:not(:last-child)) { border-top-right-radius: 0; border-bottom-right-radius: 0; }
  .who { display: inline-flex; align-items: center; gap: 6px; min-width: 0; padding: 4px 8px 4px 6px; border-radius: var(--radius); background: var(--tint); color: var(--bright); }
  .name { max-width: 12ch; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
  .state { color: var(--text); }
  .state[data-status='trading'], .state[data-status='linked'] { color: var(--buy-text); }
  .copy { display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex-shrink: 0; padding: 4px 7px; border-radius: 0 var(--radius) var(--radius) 0; background: var(--tint); color: var(--text); }
  .copy:hover { color: var(--bright); }
  .copy svg { width: 1.1em; height: 1.1em; }
  .copy:only-child { border-radius: var(--radius); }
  .copy[data-copied='true'] { color: var(--buy-text); }
  .text .copy { padding: 4px 10px; }
</style>
