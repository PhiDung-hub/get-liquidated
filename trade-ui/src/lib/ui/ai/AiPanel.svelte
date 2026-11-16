<script lang="ts">
  import { agent, companion, DESKTOP_ONLY, handheld, mentoring, pair, retryNow, setChartSharing, setAdviceNotifications, SETUP_COMMAND, CONNECTOR_SOURCE, CONNECTOR_VERSION, connectorUpdate, updateConnector, signOut, stopAnswers, terminalSessions } from '$lib/agent/agent.svelte';
  import { settings, persist } from '$lib/settings/settings.svelte';
  import { ui } from '$lib/ui/state.svelte';
  import { menus } from '$lib/ui/order/Menu.svelte';
  import AiThread from './AiThread.svelte';
  import { coach, showCoach } from './setups.svelte';
  import { CLIENTS, setupPrompt, type Client } from '$lib/agent/setupPrompt';
  import { load } from '$lib/util/storage';

  const openConnect = () => (ui.overlay = 'aiConnect');
  const openCoach = () => showCoach(coach.mode);
  let code = $state('');
  let copied = $state<'' | 'ok' | 'prompt' | 'failed'>('');
  async function copySetup(text = SETUP_COMMAND, done: 'ok' | 'prompt' = 'ok') {
    try {
      await navigator.clipboard.writeText(text);
      copied = done;
      setTimeout(() => copied === done && (copied = ''), 2500);
    } catch {
      copied = 'failed';
    }
  }
  /** The setup prompt for the client last picked under Other setup options, Claude Code by default. */
  function copyPrompt() {
    const picked = load<{ client?: unknown }>('trade-ui:ai-connect', {}).client;
    return copySetup(setupPrompt(typeof picked === 'string' && Object.hasOwn(CLIENTS, picked) ? (picked as Client) : 'claude'), 'prompt');
  }
  const paired = $derived(!handheld.current && !!agent.address);
  const update = $derived(agent.status === 'live' ? connectorUpdate() : '');
  const stop = () => stopAnswers().catch((err: Error) => (agent.error = `Could not turn off answers: ${err.message}`));
  const tap = (f: () => unknown) => (e: MouseEvent) => {
    (e.currentTarget as HTMLElement).blur();
    void f();
  };
  let gearOpen = $state(false);
  let gear = $state<HTMLButtonElement>();
  const pick = (f: () => unknown) => () => {
    gearOpen = false;
    void f();
  };
  /** Counted as an open menu, so Esc closes it and not the chart coach or a form behind it. */
  function popup(el: HTMLElement) {
    el.focus();
    menus.open++;
    return () => {
      menus.open--;
      gearOpen = false;
    };
  }
  function popupKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    gearOpen = false;
    gear?.focus();
  }
  const left = (e: FocusEvent & { currentTarget: HTMLElement }) => {
    if (e.relatedTarget && e.relatedTarget !== gear && !e.currentTarget.contains(e.relatedTarget as Node)) gearOpen = false;
  };
  const outside = (e: PointerEvent) => {
    if (gearOpen && !(e.target as Element).closest?.('[data-testid=ai-settings], [data-testid=ai-gear]')) gearOpen = false;
  };
</script>

<svelte:window onpointerdown={outside} />

{#snippet notices()}
  {#if companion.waiting}<p class="dim" data-testid="ai-permission-hint">Allow access to apps on this device (Chrome/Edge) or local network access (Firefox).</p>{/if}
  {#if agent.error && !handheld.current}<p class="err" data-testid="ai-error">{agent.error}</p>{/if}
  {#if agent.error && (agent.status === 'offline' || companion.retryPair)}<button class="open" data-testid="ai-retry" onclick={tap(retryNow)}>Retry</button>{/if}
{/snippet}

<div class="ai" class:paired data-testid="ai-panel" data-status={agent.status}>
  {#if handheld.current}
    <p data-testid="ai-desktop-only">{DESKTOP_ONLY}</p>
  {:else if agent.address}
    <div class="head">
      <span title="Your own AI (Claude Code, Codex or another MCP client) is paired with this browser">AI co-pilot <span class="dim">· MCP</span></span>
      <span class="state" class:live={agent.status === 'live'} data-testid="ai-status">{agent.status === 'live' ? 'Workspace live' : 'reconnecting…'}</span>
      <button data-testid="ai-gear" aria-label="Co-pilot settings" aria-expanded={gearOpen} bind:this={gear} onclick={() => (gearOpen = !gearOpen)} onkeydown={(e) => e.key === 'Escape' && gearOpen && (e.stopPropagation(), (gearOpen = false))}>⚙</button>
    </div>
    {#if gearOpen}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div class="ui-menu settings" data-testid="ai-settings" role="group" aria-label="Co-pilot settings" tabindex="-1" onkeydown={popupKey} onfocusout={left} {@attach popup}>
        <div class="opts" title="Your AI can draw on the chart, publish guidance and suggest a ticket you send yourself. Nothing else; conversations stay in your AI client.">
          <label title="Shares this market, timeframe, public account address, visible indicators and hotkeys while this page is visible"><input type="checkbox" data-testid="ai-share-chart" checked={mentoring.shareChart} onchange={(e) => void setChartSharing(e.currentTarget.checked)} /> See my chart</label>
          <label title="Levels, zones and bias labels your AI draws. Click one to ask about it."><input type="checkbox" data-testid="ai-show-marks" bind:checked={settings.chart.indicators.ai.on} onchange={() => persist()} /> Draw on it</label>
          <label title="A browser notification when your AI publishes advice"><input type="checkbox" data-testid="ai-advice-notifications" checked={mentoring.notifications} onchange={(e) => setAdviceNotifications(e.currentTarget.checked)} /> Notify me</label>
        </div>
        {#if agent.answerer}<p data-testid="ai-answerer"><span class="ok">Claude Code answers what you type here</span>{agent.answerer.answering.length ? ' · answering…' : ''} <button data-testid="ai-answerer-off" onclick={pick(stop)}>Turn off</button></p>{/if}
        <p class="dim">{companion.version ? `getliq ${companion.version} · ` : ''}{#if !terminalSessions().length}<span data-testid="ai-terminal-unavailable" title="Needs getliq 0.6.0 or later. Start your AI in Agent OS and ask it to report client_session with its session ID and terminal: true.">No terminal session yet.</span> · {/if}<button data-testid="ai-open-connection" title="Which AI clients are connected and what they did" onclick={pick(openConnect)}>Connection…</button></p>
        <p class="dim"><button data-testid="ai-open-coach" title="Setups and live ideas beside price" onclick={pick(openCoach)}>Chart coach</button> · <button data-testid="ai-signout" onclick={pick(signOut)}>Sign out</button></p>
      </div>
    {/if}
    {#if update === 'restart'}
      <p class="warn" data-testid="ai-update">getliq {CONNECTOR_VERSION} is installed. If this stays, restart Claude Code or Codex to load it.</p>
    {:else if update}
      <p class="warn" data-testid="ai-update">getliq {CONNECTOR_VERSION} is out{companion.version && companion.version !== CONNECTOR_VERSION ? `; this computer runs ${companion.version}` : ''}.
        {#if update === 'update'}<button data-testid="ai-update-now" disabled={companion.updating} onclick={tap(updateConnector)}>{companion.updating ? 'Updating…' : 'Update'}</button>
        {:else}<button data-testid="ai-update-copy" onclick={tap(copySetup)}>{copied === 'ok' ? 'Copied · run it in a terminal' : 'Copy update command'}</button>{/if}
      </p>
    {/if}
    {#if companion.updateError}<p class="err" data-testid="ai-update-error" title={companion.updateError}>Update failed. <button data-testid="ai-update-fallback" onclick={tap(copySetup)}>{copied === 'ok' ? 'Copied · run it in a terminal' : 'Copy the command instead'}</button></p>{/if}
    {#if agent.answerer?.error}<p class="err" data-testid="ai-answerer-error">{agent.answerer.error}</p>{/if}
    {@render notices()}
    <AiThread />
  {:else if agent.status === 'offline'}
    <p class="dim" data-testid="ai-connecting">Reconnecting to your co-pilot… Keep your AI client running on this computer.</p>
  {:else}
    <section class="card" data-testid="ai-connect-summary">
      <h4>AI co-pilot <span class="dim">· MCP</span></h4>
      <p class="dim">Your own AI coaches you on this chart. Works with Claude Code, Codex or any MCP client. It never places orders.</p>
      <div class="setup">
        <button class="signin" data-testid="ai-copy-prompt" title="Paste it into Claude Code or Codex; it runs the setup and pairs this page" onclick={tap(copyPrompt)}>{copied === 'prompt' ? 'Copied · paste it to your AI' : 'Copy setup for my AI'}</button>
        <button class="signin alt" data-testid="ai-copy-command" title={SETUP_COMMAND} onclick={tap(copySetup)}>{copied === 'ok' ? 'Copied · paste it in a terminal' : 'Copy terminal command'}</button>
      </div>
      <div class="dim">Paste it, and this page pairs itself.
        <span class="more" class:shown={copied === 'failed'} tabindex="0" role="button" aria-label="What setup runs">What does it run?
          <span class="pop">
            <code class="cmd" data-testid="ai-setup-command">{SETUP_COMMAND}</code>
            <span>Adds getliq to Claude Code and Codex on this computer, from a pinned public gist. Needs Node 24.22.1+. <a data-testid="ai-connector-source" href={CONNECTOR_SOURCE} target="_blank" rel="noreferrer">Read the code</a></span>
          </span>
        </span>
        · <button data-testid="ai-open-connect" title="Manual steps for each AI client" onclick={tap(openConnect)}>Other ways</button>
      </div>
      {#if copied === 'failed'}<p class="err" role="status">Copy failed. Select the command above.</p>{/if}
    </section>
    <form class="pair" onsubmit={(e) => (e.preventDefault(), void pair(code).then(() => !agent.error && (code = '')))}>
      <label title="Your AI prints a pairing code or link (pair_browser) when this page did not pair itself">Have a pair code?
        <input data-testid="ai-pair-code" bind:value={code} placeholder="Pairing code or link" spellcheck="false" autocomplete="off" />
      </label>
      <button class="signin" data-testid="ai-signin" disabled={agent.status === 'signing' || !code.trim()}>
        {agent.status === 'signing' ? 'Pairing…' : 'Pair local AI'}
      </button>
    </form>
  {/if}
  {#if !paired}
    <p class="coach-link dim"><button data-testid="ai-open-coach" title="Setups and live ideas beside price" onclick={tap(openCoach)}>Chart coach</button></p>
    {@render notices()}
  {/if}
</div>

<style>
  .ai { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 12px 10px 10px; }
  .ai.paired { position: relative; }
  .settings { position: absolute; z-index: 6; top: calc(1.5em + 22px); left: 10px; right: 10px; max-height: 60vh; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 10px; }
  .settings button { padding: 0; background: none; color: var(--accent); }
  .coach-link button, .card .dim button, .more { color: var(--accent); }
  .card .dim { position: relative; }
  .card .dim button { padding: 0; background: none; }
  .more { cursor: help; }
  .pop { display: none; position: absolute; z-index: 5; left: 0; right: 0; bottom: 100%; gap: 8px; padding: 10px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); color: var(--dim); cursor: auto; }
  .more:hover .pop, .more:focus-within .pop, .more.shown .pop { display: grid; }
  .setup { display: flex; flex-wrap: wrap; gap: 8px; }
  .setup button { flex: 1 1 auto; padding: 0 12px; }
  .signin.alt { background: none; border: 1px solid var(--line); color: var(--accent); }
  label { display: flex; align-items: center; gap: 8px; }
  .opts { display: flex; flex-wrap: wrap; gap: 6px 14px; }
  .err button { color: var(--accent); }
  .pair { display: flex; flex-direction: column; gap: 8px; }
  .pair label { flex-direction: column; align-items: stretch; gap: 4px; }
  .head { display: flex; align-items: center; gap: 8px; color: var(--bright); }
  .head > span:first-child { flex: 1; min-width: 0; }
  .head button { padding: 0 6px; color: var(--dim); font-size: calc(var(--fs) * 1.35); line-height: 1.2; }
  .state { color: var(--warn); font-size: max(8px, calc(var(--fs) * 0.917)); }
  .state.live { color: var(--buy); }
  .ok { color: var(--buy); }
  .warn { color: var(--warn); }
  .cmd { display: block; margin: 0; padding: 6px 8px; border: 1px solid var(--surface); border-radius: var(--radius); background: var(--bg); color: var(--bright); font: max(8px, calc(var(--fs) * 0.917)) / 1.4 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; user-select: all; }
  a { color: var(--accent); }
  .open { align-self: flex-start; padding: 6px 12px; color: var(--bright); }
  .signin { height: var(--ctl); border-radius: var(--radius); background: var(--accent); color: var(--bg); }
  p { margin: 0; }
  .dim { color: var(--dim); }
  .err { color: var(--sell); overflow-wrap: anywhere; }
</style>
