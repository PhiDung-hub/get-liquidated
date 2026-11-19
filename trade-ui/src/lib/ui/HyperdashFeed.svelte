<script lang="ts">
  import { onMount } from 'svelte';
  import { fmtTime } from '$lib/util/format';

  type Event = { time: number; coin: string; side: 'long' | 'short'; px: string; notional: string };
  const storage = 'trade-ui:hyperdash-key';
  let saved = $state('');
  let draft = $state('');
  let rows = $state<Event[] | null>(null);
  let more = $state(false);
  let error = $state('');
  let busy = $state(false);
  let active: AbortController | undefined;

  onMount(() => {
    try { saved = localStorage.getItem(storage) ?? ''; }
    catch { error = 'Local storage is unavailable in this browser.'; }
    function onStorage(e: StorageEvent) {
      if (e.storageArea !== localStorage || (e.key !== storage && e.key !== null)) return;
      active?.abort();
      saved = e.newValue ?? '';
      draft = error = '';
      rows = null;
    }
    window.addEventListener('storage', onStorage);
    return () => { active?.abort(); window.removeEventListener('storage', onStorage); };
  });

  function valid(event: Event) {
    return event && Number.isSafeInteger(event.time) && event.time > 0 && event.time < 8.64e15
      && typeof event.coin === 'string' && event.coin.length <= 80 && ['long', 'short'].includes(event.side)
      && [event.px, event.notional].every(v => typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) && v.length <= 50);
  }
  async function load() {
    if (busy) return;
    const key = saved || draft.trim();
    error = '';
    if (!/^hdk_sk_live_v1_[A-Za-z0-9_-]{1,256}$/.test(key)) { error = 'Enter a Hyperdash Data API key.'; return; }
    const request = new AbortController();
    active = request;
    busy = true;
    rows = null;
    try {
      const response = await fetch('/api/hyperdash/liquidations', { headers: { Authorization: 'Bearer ' + key }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]) });
      if (!response.ok) {
        error = response.status === 401 ? 'Hyperdash rejected this key.' : response.status === 403 ? 'Check the key’s liquidations:read scope, plan and credits.' : response.status === 429 ? 'Rate limit reached. Try again later.' : 'Liquidations are unavailable. Try again.';
        return;
      }
      const result = await response.json();
      if (request.signal.aborted) return;
      if (!Array.isArray(result?.data) || result.data.length > 50 || !result.data.every(valid) || typeof result.has_more !== 'boolean') throw new Error();
      if (!saved) {
        try { localStorage.setItem(storage, key); }
        catch { error = 'Could not save the key on this device.'; return; }
        saved = key;
        draft = '';
      }
      rows = result.data.toSorted((a: Event, b: Event) => b.time - a.time);
      more = result.has_more;
    } catch { if (!request.signal.aborted) error = 'Could not load liquidation data. Try again.'; }
    finally { busy = false; }
  }
  function disconnect() {
    try { localStorage.removeItem(storage); }
    catch { error = 'Could not remove the saved key.'; return; }
    saved = draft = error = '';
    rows = null;
  }
</script>

<section data-testid="integration-hyperdash">
  <h4>Hyperdash liquidations</h4>
  <p>The key is saved in this browser and relayed to Hyperdash when you connect or refresh. Each request reads one minute of liquidations and uses 70 credits plus one per row.</p>
  {#if !saved}
    <form onsubmit={(e) => { e.preventDefault(); void load(); }}>
      <label>Hyperdash Data API key<input class="ui-field" type="password" bind:value={draft} autocomplete="off" spellcheck="false" required /></label>
      <button disabled={busy || !draft.trim()}>Connect</button>
    </form>
  {:else}
    <div class="controls"><button disabled={busy} onclick={load}>Refresh feed</button><button disabled={busy} onclick={disconnect}>Disconnect</button></div>
  {/if}
  {#if busy}<p role="status">Loading liquidations…</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if rows}
    {#if rows.length}
      <div class="history"><table aria-label="Hyperdash liquidations"><thead><tr><th>Time (UTC)</th><th>Market</th><th>Liquidated side</th><th>Price</th><th>Value (USD)</th></tr></thead><tbody>
        {#each rows as row}<tr><td>{fmtTime(row.time)}</td><td>{row.coin}</td><td>{row.side}</td><td>{row.px}</td><td>{row.notional}</td></tr>{/each}
      </tbody></table></div>
      {#if more}<p>Showing the first 50 events in this minute.</p>{/if}
    {:else}<p>No liquidations in the past minute.</p>{/if}
  {/if}
</section>

<style>
  section { min-width: 0; padding: 14px; background: var(--bg); border-radius: var(--radius); }
  h4 { margin: 0; color: var(--bright); }
  p { color: var(--dim); line-height: 1.5; }
  label { display: grid; gap: 4px; }
  input { min-width: 0; width: 100%; }
  form, .controls { display: flex; align-items: end; flex-wrap: wrap; gap: 8px; }
  .history { overflow-x: auto; margin-top: 8px; }
  th, td { white-space: nowrap; }
</style>
