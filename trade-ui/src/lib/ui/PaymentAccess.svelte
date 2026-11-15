<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { session, wallet, walletReady } from '$lib/session/session.svelte';
  import { parseAccounts, walletChoices, wallets } from '$lib/session/wallet.svelte';
  import { ACCESS_KEY_PATTERN, currentAccess, forgetAccess, setAccess, storedAccessKey, type ApiAccess } from '$lib/session/access.svelte';

  type Config = { schema_version: 1; mode: 'disabled' | 'test' | 'live'; network: 'Mainnet' | 'Testnet'; recipient: string | null; minimum: '0.01'; asset: 'USDC'; enabled: boolean };
  type Order = { id: string; wallet: string; recipient: string; network: 'Mainnet' | 'Testnet'; amount: '0.01'; status: 'pending' | 'paid' | 'expired' | 'paid_late'; createdAt: number; expiresAt: number; paidAt?: number | null };
  const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
  const ID = /^[A-Za-z0-9_-]{1,128}$/;
  const KEY = ACCESS_KEY_PATTERN;
  let config = $state<Config | null>(null);
  let order = $state<Order | null>(null);
  let access = $state<ApiAccess | null>(null);
  let secret = $state('');
  let existing = $state('');
  let remember = $state(false);
  let rotating = $state(false);
  let busy = $state('');
  let error = $state('');
  let notice = $state('');
  let active: AbortController | null = null;
  let generation = 0;
  const owner = $derived(session.master);
  const canSign = $derived(!!owner && !session.linked && walletReady() && walletChoices().some((choice) => choice.id === wallets.selected));
  const recipient = $derived(config?.enabled ? order?.recipient ?? config.recipient : owner);
  const paid = $derived(order?.status === 'paid');
  const settled = $derived(paid || order?.status === 'paid_late');
  const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
  const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
  const prefix = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
  const orderKey = (address: string) => `trade-ui:payment-order:${address.toLowerCase()}`;

  async function api(path: string, body: object | undefined = undefined, key = ''): Promise<unknown> {
    const response = await fetch(`/api/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([active!.signal, AbortSignal.timeout(12_000)])
    });
    let value: unknown;
    try { value = await response.json(); } catch { throw new Error('Access service returned an unreadable response. Try again.'); }
    if (!response.ok) {
      if (response.status === 409 && path === 'payments/keys' && record(value) && value.error === 'key_exists') throw new Error('This wallet already has a key. Use your saved key, or rotate it to replace the key on every device.');
      const message = record(value) && typeof value.message === 'string' && value.message.length <= 300 ? value.message
        : record(value) && typeof value.error === 'string' && value.error.length <= 300 ? value.error : 'Access service is unavailable. Try again.';
      throw Object.assign(new Error(message), { status: response.status });
    }
    return value;
  }

  async function run(label: string, action: (current: () => boolean) => Promise<void>) {
    if (busy) return;
    const token = generation;
    const controller = new AbortController();
    active = controller;
    busy = label;
    error = '';
    notice = '';
    const current = () => token === generation && !controller.signal.aborted;
    try { await action(current); }
    catch (cause) { if (current()) error = cause instanceof Error ? cause.message : 'Access request failed. Try again.'; }
    finally { if (current()) { busy = ''; active = null; } }
  }

  function readOrder(value: unknown, address: string): Order {
    if (!record(value) || typeof value.id !== 'string' || !ID.test(value.id) || typeof value.wallet !== 'string' || value.wallet.toLowerCase() !== address.toLowerCase()
      || typeof value.recipient !== 'string' || !ADDRESS.test(value.recipient) || !['Mainnet', 'Testnet'].includes(value.network)
      || value.amount !== '0.01' || !['pending', 'paid', 'expired', 'paid_late'].includes(value.status)
      || !time(value.createdAt) || !time(value.expiresAt) || (value.paidAt != null && !time(value.paidAt))) throw new Error('Payment details could not be verified. Refresh before paying.');
    return value as Order;
  }

  function acceptOrder(value: unknown, address: string) {
    const next = readOrder(value, address);
    order = next;
    try { localStorage.setItem(orderKey(address), next.id); } catch { notice = 'Payment is ready; this browser could not save its reference. Keep this page open.'; }
  }

  async function refresh() {
    await run('Loading', async (current) => {
      const value = await api('payments/config');
      if (!current()) return;
      if (!record(value) || value.schema_version !== 1 || !['disabled', 'test', 'live'].includes(value.mode) || !['Mainnet', 'Testnet'].includes(value.network)
        || value.minimum !== '0.01' || value.asset !== 'USDC' || typeof value.enabled !== 'boolean'
        || !(value.recipient === null || (typeof value.recipient === 'string' && ADDRESS.test(value.recipient)))
        || (value.enabled && (value.mode === 'disabled' || !value.recipient))) throw new Error('Payment configuration could not be verified. Collection is disabled.');
      config = value as Config;
      const address = owner;
      let saved: string | null = null;
      try { saved = address && localStorage.getItem(orderKey(address)); } catch { notice = 'This browser could not read its saved payment reference.'; }
      if (address && saved && ID.test(saved)) {
        const restored = await api('payments/orders/status', { orderId: saved });
        if (current()) acceptOrder(restored, address);
      }
    });
  }

  async function signed(purpose: 'payment' | 'issue_key' | 'rotate_key', current: () => boolean) {
    const address = owner;
    if (!address || session.linked || !walletReady()) throw new Error('Connect the paying wallet directly to sign. A read-only account or linked trading key cannot authorize access.');
    const provider = wallet();
    const check = async () => {
      if (!current() || owner !== address || session.linked || !walletReady() || wallet() !== provider) throw new Error('Wallet changed. Start again with the paying wallet.');
      const accounts = parseAccounts(await provider.request({ method: 'eth_accounts' }));
      if (!current() || owner !== address || wallet() !== provider || accounts[0] !== address.toLowerCase()) throw new Error('Select the connected paying wallet in your extension, then try again.');
    };
    await check();
    const challenge = await api('payments/challenge', { wallet: address, purpose });
    if (!current()) throw new Error('Wallet changed. Start again.');
    if (!record(challenge) || typeof challenge.id !== 'string' || !/^[0-9a-f]{64}$/.test(challenge.id) || typeof challenge.message !== 'string'
      || !time(challenge.expiresAt) || !Number.isInteger(challenge.expiresAt) || challenge.expiresAt <= Date.now() || challenge.expiresAt > Date.now() + 310_000) throw new Error('Wallet authorization could not be verified. Try again.');
    const expected = `Get Liquidated payment authorization v1\nOrigin: ${location.origin}\nNetwork: ${config!.network}\nWallet: ${address.toLowerCase()}\nPurpose: ${purpose}\nNonce: ${challenge.id}\nExpires at: ${challenge.expiresAt}\nThis signature authorizes only this request. It grants no trading or withdrawal permission.`;
    if (challenge.message !== expected) throw new Error('Wallet authorization does not match this site, network, wallet or action. Nothing was signed.');
    await check();
    const message = challenge.message;
    const hex = '0x' + Array.from(new TextEncoder().encode(message), byte => byte.toString(16).padStart(2, '0')).join('');
    const signature = await provider.request({ method: 'personal_sign', params: [hex, address] });
    await check();
    if (challenge.expiresAt <= Date.now()) throw new Error('Wallet authorization expired. Start again for a fresh signature.');
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('Wallet returned an invalid signature. Try again.');
    return { challengeId: challenge.id, message, signature };
  }

  async function createOrder() {
    if (!config?.enabled || !canSign || settled) return;
    await run('Creating payment', async (current) => {
      const address = owner!;
      const proof = await signed('payment', current);
      const value = await api('payments/orders', proof);
      if (current()) acceptOrder(value, address);
    });
  }

  async function checkOrder() {
    if (!order || !owner || !config?.enabled) return;
    await run('Checking receipt', async (current) => {
      const value = await api('payments/orders/check', { orderId: order!.id });
      if (current()) acceptOrder(value, owner!);
    });
  }

  async function issueKey(rotate = false) {
    if (!canSign || !config) return;
    await run(rotate ? 'Rotating key' : 'Creating key', async (current) => {
      secret = '';
      const proof = await signed(rotate ? 'rotate_key' : 'issue_key', current);
      let value: unknown;
      try { value = await api('payments/keys', proof); }
      catch (cause) {
        if ((cause instanceof DOMException && ['TimeoutError', 'AbortError'].includes(cause.name)) || cause instanceof TypeError
          || (cause instanceof Error && cause.message.startsWith('Access service returned an unreadable response'))
          || (record(cause) && typeof cause.status === 'number' && cause.status >= 500)) throw new Error('The key request did not finish. Its outcome is unknown; rotate the key with a fresh wallet signature to replace it.');
        throw cause;
      }
      if (!current()) return;
      if (!record(value) || typeof value.wallet !== 'string' || value.wallet.toLowerCase() !== owner?.toLowerCase() || typeof value.key !== 'string' || !KEY.test(value.key) || !prefix(value.prefix) || !time(value.createdAt)) throw new Error('Key response could not be read. Do not retry issuance; rotate the key to replace it.');
      secret = value.key;
      access = { wallet: value.wallet, paid: true, keyPrefix: value.prefix, createdAt: value.createdAt };
      rotating = false;
      try { setAccess(value.key, access, false); } catch { notice = 'Key active for this visit. Remove any older key saved on this device.'; }
    });
  }

  async function useKey() {
    const key = existing.trim();
    if (!KEY.test(key)) { error = 'Enter a valid API key.'; return; }
    await run('Validating key', async (current) => {
      const value = await api('payments/access', undefined, key);
      if (!current()) return;
      if (!record(value) || typeof value.wallet !== 'string' || !ADDRESS.test(value.wallet) || value.paid !== true || !prefix(value.keyPrefix) || !time(value.createdAt)) throw new Error('Access response could not be verified.');
      access = value as ApiAccess;
      try {
        setAccess(key, access, remember);
      } catch { notice = 'Key validated, but this browser could not update its saved key.'; }
      existing = '';
      notice ||= remember ? 'Key validated and saved on this device.' : 'Key validated for this visit.';
    });
  }

  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); notice = `${label} copied.`; }
    catch { error = `Clipboard unavailable. Select and copy the ${label.toLowerCase()} manually.`; }
  }

  function forget() {
    try { forgetAccess(); notice = 'Key removed from this device.'; }
    catch { error = 'Key cleared for this visit, but this browser could not remove its saved key.'; }
    access = null;
    existing = '';
    secret = '';
  }

  $effect(() => {
    void owner;
    generation++;
    active?.abort();
    active = null;
    busy = '';
    order = null;
    access = untrack(currentAccess);
    secret = '';
    existing = '';
    rotating = false;
    error = '';
    notice = '';
    untrack(() => void refresh());
    return () => { generation++; active?.abort(); secret = ''; };
  });

  onMount(() => {
    try { const saved = storedAccessKey(); if (saved && KEY.test(saved)) { existing = saved; remember = true; } } catch { notice = 'This browser could not read a saved key. Paste your key to validate it.'; }
  });
</script>

<section class="access" data-testid="payment-access">
  <header><h4>API access</h4><span class="badge">0.01 USDC · HyperCore</span></header>
  <p>One key per paid wallet, usable on unlimited devices. Keep it private: keys authorize backend API access.</p>
  {#if !config}<button onclick={refresh} disabled={!!busy}>{busy || 'Retry configuration'}</button>{/if}
  {#if config && !config.enabled}
    <p class="warn" data-testid="payment-disabled">Collection disabled. Payments cannot be created here; do not send funds.</p>
    {#if recipient}<p class="address" data-testid="payment-recipient-preview">Preview only · your connected wallet<br /><code>{recipient}</code></p>{/if}
  {:else if config && !order}
    <p>Create a reference before making a manual HyperCore {config.network} transfer. HyperEVM transfers do not count.</p>
  {:else if config && order?.status === 'pending'}
    <p>Use a manual <strong>HyperCore {order.network}</strong> transfer. HyperEVM transfers do not count.</p>
    <p class="address">Recipient <code data-testid="payment-recipient">{recipient}</code><button onclick={() => copy(recipient!, 'Recipient')}>Copy</button></p>
  {/if}
  {#if canSign}<p>Connected paying wallet <code>{owner}</code></p>{:else}<p>{session.linked ? 'Connect the paying wallet directly; a linked trading key cannot sign access requests.' : 'Connect the paying wallet to create a payment or manage its key.'}</p>{/if}
  <button data-testid="payment-create" disabled={!!busy || !config?.enabled || !canSign || settled} onclick={createOrder}>Create payment reference</button>
  {#if order}
    <div class="receipt" data-testid="payment-order">
      <span>Receipt <code>{order.id}</code></span><strong class:paid class:warn={order.status === 'paid_late' || order.status === 'expired'} data-testid="payment-status">{order.status.replace('_', ' ')}</strong>
      {#if order.status === 'pending' && config?.enabled}
        <span data-testid="payment-instructions">Send at least <strong>0.01 USDC</strong> on HyperCore {order.network} from <code>{order.wallet}</code></span>
      {:else if order.status === 'pending'}
        <p class="warn" data-testid="payment-guidance">Collection is paused. Do not send funds.</p>
      {:else if paid}
        <p class="paid" data-testid="payment-guidance">Payment verified. No further payment is needed.</p>
      {:else if order.status === 'paid_late'}
        <p class="warn" data-testid="payment-guidance">Late payment received. Access needs manual review; do not pay again.</p>
      {:else}
        <p class="warn" data-testid="payment-guidance">Reference expired. Do not send funds to this reference; check any existing payment receipt.</p>
      {/if}
      <span>Recipient <code>{order.recipient}</code></span>
      <span>Reference expires {new Date(order.expiresAt).toLocaleString()}</span>
      <button data-testid="payment-check" disabled={!!busy || !config?.enabled} onclick={checkOrder}>Check payment receipt</button>
    </div>
  {/if}
  <div class="key-actions">
    <button data-testid="access-issue" disabled={!!busy || !canSign || !config} onclick={() => issueKey()}>Create key for paid wallet</button>
    {#if rotating}
      <p class="warn" data-testid="access-rotation-warning">Replace the key for <code>{owner}</code>? The old key stops working on every device. Save the replacement; it cannot be recovered.</p>
      <button class="danger" data-testid="access-rotate-confirm" disabled={!!busy || !canSign || !config} onclick={() => issueKey(true)}>Rotate and revoke old key</button>
      <button disabled={!!busy} onclick={() => rotating = false}>Cancel</button>
    {:else}<button data-testid="access-rotate" disabled={!!busy || !canSign || !config} onclick={() => rotating = true}>Rotate key…</button>{/if}
  </div>
  {#if secret}
    <div class="secret" data-testid="access-secret">
      <strong>Save this key now. It is shown once and cannot be recovered.</strong>
      <code>{secret}</code>
      <div><button data-testid="access-copy" onclick={() => copy(secret, 'API key')}>Copy key</button><button data-testid="access-dismiss" onclick={() => secret = ''}>I saved it · hide</button></div>
      <p>Use the same key on all your devices. If lost, sign with the paying wallet to rotate it.</p>
    </div>
  {/if}
  <form onsubmit={(event) => { event.preventDefault(); void useKey(); }}>
    <label>Use existing key<input data-testid="access-existing" type="password" autocomplete="off" spellcheck="false" bind:value={existing} disabled={!!busy} /></label>
    <label class="remember"><input type="checkbox" bind:checked={remember} disabled={!!busy} /> Remember on this device</label>
    <button data-testid="access-validate" disabled={!!busy || !existing.trim()}>Validate key</button>
  </form>
  {#if access}
    <p class="paid" data-testid="access-status">Paid wallet <code>{access.wallet}</code> · key <code>{access.keyPrefix}…</code></p>
    <button data-testid="access-forget" disabled={!!busy} onclick={forget}>Forget on this device</button>
  {:else if paid}<p class="paid">Payment verified. Sign with this wallet to create its API key.</p>{/if}
  {#if busy}<p role="status">{busy}…</p>{/if}
  {#if error}<p class="error" role="alert" data-testid="access-error">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
</section>

<style>
  .access { display: grid; gap: 8px; min-width: 0; padding: 10px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); }
  header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px; }
  h4, p { margin: 0; }
  h4 { color: var(--bright); font-weight: 600; }
  p, .badge, .receipt { color: var(--dim); line-height: 1.5; }
  .badge { font: 0.9em var(--mono); }
  code { font-family: var(--mono); overflow-wrap: anywhere; word-break: break-all; }
  .address { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .receipt, .secret { display: grid; gap: 6px; min-width: 0; padding: 8px; border: 1px solid var(--line); }
  .receipt code { color: var(--text); }
  .key-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .key-actions p { flex-basis: 100%; }
  form { display: grid; gap: 6px; border-top: 1px solid var(--line); padding-top: 8px; }
  label { display: grid; gap: 4px; }
  input { min-width: 0; width: 100%; box-sizing: border-box; }
  .remember { display: flex; align-items: center; gap: 6px; }
  .remember input { width: auto; }
  button { justify-self: start; padding: 4px 8px; }
  strong { color: var(--bright); }
  .paid, strong.paid { color: var(--buy-text); }
  .warn { color: var(--warn); }
  .error, .danger { color: var(--sell-text); }
</style>
