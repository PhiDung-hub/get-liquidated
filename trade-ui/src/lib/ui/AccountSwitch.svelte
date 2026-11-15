<script module lang="ts">
  import { accounts, inFlight, session, useMaster } from '$lib/session/session.svelte';
  import { busy } from '$lib/orders/chase.svelte';
  import { fmtAddr } from '$lib/util/format';
  import { ui } from './state.svelte';
  import { toast } from './toast.svelte';


  /** The agent signs for the account an order or chase started on, so a switch waits until nothing is in flight. */
  function refusal() {
    if (busy()) return 'stop chases and wait for pending orders before switching account';
    if (inFlight()) return 'wait for queued keys and orders in flight before switching account';
    if (ui.overlay) return 'close the overlay before switching account';
    return '';
  }

  export async function switchAccount(address: string) {
    if (address === session.master) return;
    const why = refusal();
    if (why) throw new Error(why);
    await useMaster(address);
  }

  export function cycleAccount() {
    const list = accounts.list;
    if (!session.master || list.length < 2) throw new Error('add another account from the address menu first');
    const i = list.findIndex((a) => a.address === session.master);
    return switchAccount(list[(i + 1) % list.length].address);
  }
</script>

<script lang="ts">
  import { addWalletAccount, enableTrading, removeAccount, renameAccount, savedAgent, type Account, type ExtraAgent } from '$lib/session/session.svelte';
  import { tick } from 'svelte';
  import { info } from '$lib/transport/info';
  import { fmtUsd } from '$lib/util/format';
  import { bindingsFor, keyLabel } from '$lib/hotkeys/keymap';
  import Wallet, { identicon, walletStatus } from './Wallet.svelte';

  let { compact = false } = $props();
  let open = $state(false);
  let root = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();
  let at = $state('');
  let editing = $state('');
  let confirming = $state('');
  let confirmTimer: ReturnType<typeof setTimeout> | undefined;
  const values = $state<Record<string, number>>({});
  const valid = $state<Record<string, boolean>>({});
  const label = $derived(accounts.list.find((a) => a.address === session.master)?.label ?? '');
  const nextKeys = $derived(bindingsFor('cycleAccount').map(keyLabel).join(' / '));

  /** One read per account each time the list opens; nothing polls. */
  function refresh() {
    for (const { address } of accounts.list) {
      // portfolio's latest "day" point is HL's total equity: spot, every perp dex and unified/portfolio-margin balances.
      info<[string, { accountValueHistory: [number, string][] }][]>({ type: 'portfolio', user: address })
        .then((p) => Number(p.find(([k]) => k === 'day')?.[1].accountValueHistory.at(-1)?.[1] ?? NaN))
        .then((v) => (values[address] = v), () => (values[address] = NaN));
      const agent = savedAgent(address);
      if (agent && address !== session.master)
        info<ExtraAgent[]>({ type: 'extraAgents', user: address }).then((l) => Array.isArray(l) && (valid[address] = l.some((x) => String(x?.address).toLowerCase() === agent)), () => {});
    }
  }
  const trading = (address: string) => (address === session.master ? !!session.agent : !!savedAgent(address) && valid[address] !== false);
  const value = (address: string) => (address in values ? fmtUsd(values[address]) : '…');

  function toggle(e: MouseEvent & { currentTarget: HTMLElement }) {
    if (open) return close(e.detail === 0);
    const r = e.currentTarget.getBoundingClientRect();
    at = `--top: ${r.bottom + 4}px; --right: ${Math.max(8, innerWidth - r.right)}px`;
    open = true;
    refresh();
  }
  /** Keyboard closes hand focus back to the trigger; pointer closes blur, as hotkeys need. */
  function close(keyboard = false) {
    open = false;
    editing = '';
    confirming = '';
    if (keyboard) trigger?.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  }
  const act = (f: () => unknown) => (e: MouseEvent) => {
    close(e.detail === 0);
    Promise.resolve().then(f).catch((e) => toast.error(e.message));
  };
  const enable = (address: string) => act(async () => (await switchAccount(address), await enableTrading()));
  /** A linked phone has no wallet: another account comes from its desktop's Link phone QR. */
  const scan = act(() => {
    const why = refusal();
    if (why) throw new Error(why);
    ui.overlay = 'linkScan';
  });
  const add = act(() => {
    const why = refusal();
    if (why) throw new Error(why);
    return addWalletAccount(refusal);
  });
  function labelKey(e: KeyboardEvent & { currentTarget: HTMLInputElement }, a: Account) {
    e.stopPropagation();
    if (e.key === 'Escape') e.currentTarget.value = a.label;
    if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
  }
  function saveLabel(address: string, text: string) {
    editing = '';
    renameAccount(address, text);
  }
  /** Removing forgets the account's agent and sizes, so it takes a second press. */
  async function remove(e: MouseEvent, address: string) {
    clearTimeout(confirmTimer);
    if (confirming !== address) {
      confirming = address;
      confirmTimer = setTimeout(() => (confirming = ''), 3000);
      return;
    }
    confirming = '';
    const i = accounts.list.findIndex((a) => a.address === address);
    removeAccount(address);
    if (e.detail) return;
    await tick();
    const picks = root?.querySelectorAll<HTMLElement>('.pick');
    (picks?.[Math.min(i, picks.length - 1)] ?? trigger)?.focus();
  }
  const outside = (e: Event) => open && !root?.contains(e.target as Node) && close();
</script>

<svelte:window onpointerdowncapture={outside} onkeydown={(e) => open && e.key === 'Escape' && close(true)} />

<div class="acct" class:compact bind:this={root}>
  {#snippet trig()}
    {@const s = walletStatus()}
    <button class="num switch" class:compact data-testid="account-switch" aria-haspopup="dialog" aria-expanded={open} aria-label="{label ? `${label} ` : ''}{fmtAddr(session.master ?? '')}" title="Accounts: {label ? `${label} ` : ''}{session.master}{s ? ` · ${s.text}` : ''}" bind:this={trigger} onclick={toggle}>
      {@render identicon(session.master ?? '', s?.id)}{#if !compact}{#if label}<span class="label">{label}</span>{/if}<span class="addr">{fmtAddr(session.master ?? '')}</span>{/if}▾
    </button>
  {/snippet}
  <Wallet address={session.master ?? ''} children={trig} copyable={!compact} />
  {#if open}
    <div class="scrim" role="presentation" onclick={() => close()}></div>
    <div class="list" role="dialog" aria-label="Accounts" data-testid="account-list" style={at}>
      {#each accounts.list as a (a.address)}
        {@const on = a.address === session.master}
        {@const ok = trading(a.address)}
        <div class="row" class:on data-testid="account-row" data-address={a.address} data-active={on}>
          <button class="pick" title="Switch to this account" aria-label="Switch to {a.label || fmtAddr(a.address)}" aria-current={on || undefined} onclick={act(() => switchAccount(a.address))}>{@render identicon(a.address, ok ? 'trading' : 'enable')}</button>
          {#if editing === a.address}
            <input data-testid="account-label-input" aria-label="Account name" value={a.label} maxlength="24" placeholder="name"
              onkeydown={(e) => labelKey(e, a)} onblur={(e) => saveLabel(a.address, e.currentTarget.value)} {@attach (el) => (el.focus(), el.select())} />
          {:else}
            <button class="name" class:unnamed={!a.label} data-testid="account-rename" title="Rename" onclick={() => (editing = a.address)}>{a.label || 'Add name'}</button>
          {/if}
          <span class="addr"><span class="num">{fmtAddr(a.address)}</span><Wallet address={a.address} /></span>
          <span class="meta">
            <span class="num value" data-testid="account-value">{value(a.address)}</span>
            {#if ok}
              <span class="ok" data-testid="account-trading">Trading</span>
            {:else if session.linked}
              <button class="enable" data-testid="account-relink" title="Scan a new Link phone QR from this account's desktop" onclick={scan}>Link again</button>
            {:else}
              <button class="enable" data-testid="account-enable" title="Needs your wallet on this address" onclick={enable(a.address)}>Enable trading</button>
            {/if}
          </span>
          {#if on}<span class="rm"></span>{:else}<button class="rm" class:sure={confirming === a.address} data-testid="account-remove" aria-label={confirming === a.address ? 'Confirm remove from list' : 'Remove from list'} title="Remove from list (forgets its trading key and sizes)" onclick={(e) => remove(e, a.address)}>{confirming === a.address ? 'Remove?' : '✕'}</button>{/if}
        </div>
      {/each}
      {#if session.linked}
        <button class="add" data-testid="account-add" onclick={scan}>+ Link another wallet <span class="dim">Scan the Link phone QR from that wallet's desktop</span></button>
      {:else}
        <button class="add" data-testid="account-add" onclick={add}>+ Add account <span class="dim">Switch your wallet to it, then Connect</span></button>
      {/if}
      {#if nextKeys && accounts.list.length > 1}<p class="dim hint" data-testid="account-hotkey"><kbd>{nextKeys}</kbd> switches to the next account</p>{/if}
    </div>
  {/if}
</div>

<style>
  .acct { display: inline-flex; min-width: 0; }
  .acct.compact { flex-shrink: 0; }
  .switch { display: inline-flex; align-items: center; gap: 6px; min-width: 0; padding: 4px 8px 4px 6px; border-radius: var(--radius); background: var(--tint); color: var(--bright); }
  .switch .label { max-width: 12ch; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
  .switch.compact { padding: 4px 6px; }
  .switch[aria-expanded='true'] { position: relative; z-index: 41; }
  .scrim { position: fixed; inset: 0; z-index: 39; }
  .list { --mono: ui-monospace, monospace; font-family: var(--mono); position: fixed; top: var(--top); right: var(--right); z-index: 40; display: grid; gap: 2px; min-width: 300px; max-width: min(440px, calc(100vw - 16px)); padding: 6px; background: var(--panel); border: 1px solid var(--surface); border-radius: var(--radius); white-space: nowrap; }
  .row { --tint: var(--panel); position: relative; display: grid; grid-template: 'pick name value rm' 'pick addr state .' / auto minmax(0, 1fr) auto auto; gap: 1px 10px; align-items: center; padding: 6px 4px 6px 8px; border-radius: var(--radius); }
  .row:hover { --tint: color-mix(in srgb, var(--surface) 55%, var(--panel)); background: var(--tint); }
  .row.on { --tint: var(--surface); background: var(--tint); }
  .meta { display: contents; }
  .row button { min-width: auto; background: none; padding: 2px 0; text-align: left; }
  .pick { grid-area: pick; position: static; display: flex; }
  .pick::after { content: ''; position: absolute; inset: 0; border-radius: inherit; }
  .pick :global(.id) { width: 1.9em; height: 1.9em; }
  .name, input, .addr :global(.copy), .enable, .rm { position: relative; z-index: 1; }
  .name { grid-area: name; justify-self: start; max-width: 100%; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
  .on .name { color: var(--bright); font-weight: 600; }
  .name.unnamed { color: var(--dim); font-style: italic; font-weight: 400; }
  input { grid-area: name; width: 100%; min-width: 0; }
  .addr { grid-area: addr; display: inline-flex; align-items: center; gap: 2px; min-width: 0; color: var(--dim); font-size: max(8px, 0.9em); }
  .addr :global(.copy) { background: none; padding: 2px 4px; color: var(--dim); }
  .addr :global(.copy:hover) { color: var(--bright); }
  .value { grid-area: value; justify-self: end; color: var(--bright); }
  .ok, .enable { grid-area: state; justify-self: end; font-size: max(8px, 0.9em); }
  .ok { color: var(--buy-text); }
  .row .enable { padding: 2px 8px; border-radius: var(--radius); background: var(--accent); color: var(--bg); font-weight: 600; }
  .rm { grid-area: rm; text-align: center; }
  .row .rm { min-width: 2em; padding: 2px 6px; color: var(--dim); opacity: 0; }
  .row:hover .rm, .row .rm:focus-visible { opacity: 1; }
  .row .rm:hover { color: var(--bright); }
  .row .rm.sure { opacity: 1; color: var(--sell-text); font-weight: 600; }
  .add { display: grid; gap: 1px; margin-top: 4px; padding: 8px; border-top: 1px solid var(--line); border-radius: 0 0 var(--radius) var(--radius); background: none; text-align: left; color: var(--text); }
  .add:hover { background: var(--surface); }
  .add .dim { font-size: max(8px, 0.85em); white-space: normal; }
  .hint { margin: 0; padding: 2px 8px 4px; font-size: max(8px, 0.85em); }
  .hint kbd { font: inherit; padding: 0 4px; border-radius: var(--radius); background: var(--surface); color: var(--text); }
  @media (pointer: coarse) {
    .hint { display: none; }
    .row .rm { opacity: 1; min-width: 36px; min-height: 36px; }
  }
  @media (max-width: 900px) {
    .row:has(.enable) { grid-template: 'pick name value rm' 'pick addr addr .' 'pick state state .' / auto minmax(0, 1fr) auto auto; }
    .row .enable { justify-self: start; margin-top: 4px; }
    .scrim { background: #000b; }
    .list { inset: auto 0 0; min-width: 0; max-width: none; max-height: 80dvh; overflow-y: auto; padding: 8px 10px calc(8px + env(safe-area-inset-bottom)); border-width: 1px 0 0; border-radius: var(--radius) var(--radius) 0 0; }
  }
</style>
