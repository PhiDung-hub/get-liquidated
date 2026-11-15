<script lang="ts">
  import { onMount } from 'svelte';
  import PaymentAccess from './PaymentAccess.svelte';

  type Integration = { id: string; name: string; availability: 'awaiting_api'; data_available: false; message: string };
  let providers = $state<Integration[]>([]);
  let loading = $state(true);
  let error = $state('');
  let controller: AbortController | null = null;

  function isIntegration(value: unknown): value is Integration {
    if (!value || typeof value !== 'object') return false;
    const provider = value as Record<string, unknown>;
    return typeof provider.id === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(provider.id)
      && typeof provider.name === 'string' && provider.name.trim().length > 0 && provider.name.length <= 80
      && provider.availability === 'awaiting_api' && provider.data_available === false
      && typeof provider.message === 'string' && provider.message.length <= 500;
  }

  async function refresh() {
    controller?.abort();
    const active = new AbortController();
    controller = active;
    loading = true;
    error = '';
    try {
      const response = await fetch('/api/integrations', { signal: AbortSignal.any([active.signal, AbortSignal.timeout(8_000)]) });
      if (!response.ok) throw new Error('Integration information is temporarily unavailable. Try again shortly.');
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('schema_version' in data) || data.schema_version !== 1 || !('integrations' in data) || !Array.isArray(data.integrations) || data.integrations.length > 20) throw new Error('Integration information could not be read. Try again shortly.');
      if (!data.integrations.every(isIntegration) || new Set(data.integrations.map(p => p.id)).size !== data.integrations.length) throw new Error('Integration information could not be read. Try again shortly.');
      if (controller === active) providers = data.integrations;
    } catch (cause) {
      if (!active.signal.aborted && controller === active) error = cause instanceof Error && cause.message.startsWith('Integration information') ? cause.message : 'Integration information is temporarily unavailable. Try again shortly.';
    } finally {
      if (controller === active) loading = false;
    }
  }

  onMount(() => {
    void refresh();
    return () => { controller?.abort(); controller = null; };
  });
</script>

<div class="integrations" data-testid="integration-settings">
  <PaymentAccess />
  <p class="intro">Additional market data</p>
  {#if loading}
    <p role="status">Loading integrations…</p>
  {:else if error}
    <div class="error" role="status"><p>{error}</p><button onclick={refresh}>Retry</button></div>
  {:else}
    {#each providers as provider (provider.id)}
      <section data-testid="integration-{provider.id}">
        <header><h4>{provider.name}</h4><span class="badge">Coming soon</span></header>
        <p>{provider.message}</p>
        {#if provider.id === 'hyperdash'}<a href="https://hyperdash.com" target="_blank" rel="noopener noreferrer">About Hyperdash ↗</a>{/if}
      </section>
    {/each}
    {#if !providers.length}<p>No additional market data integrations are configured.</p>{/if}
  {/if}
</div>

<style>
  .integrations { display: grid; gap: 12px; margin-top: 14px; }
  .intro { margin: 0; color: var(--dim); }
  section, .error { padding: 14px 16px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h4 { margin: 0; font-weight: 600; color: var(--bright); }
  .badge { padding: 3px 7px; border: 1px solid var(--line); border-radius: var(--radius); color: var(--dim); font-size: max(8px, 0.9em); }
  p { color: var(--dim); line-height: 1.5; }
  a { color: var(--accent); }
  .error p { margin-top: 0; }
</style>
