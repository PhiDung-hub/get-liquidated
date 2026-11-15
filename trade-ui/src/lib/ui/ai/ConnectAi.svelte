<script lang="ts">
  import { CONNECTOR_SOURCE, SETUP_COMMAND } from '$lib/agent/agent.svelte';
  import { args, CLIENTS, command, launch, setupPrompt, type Client } from '$lib/agent/setupPrompt';
  import { ui } from '$lib/ui/state.svelte';
  import { load, save } from '$lib/util/storage';

  const DEFAULT = { name: 'getliq' };
  const KEY = 'trade-ui:ai-connect';

  const stored = load<{ client?: unknown; name?: unknown }>(KEY, {});
  let client = $state<Client>(typeof stored.client === 'string' && Object.hasOwn(CLIENTS, stored.client) ? (stored.client as Client) : 'claude');
  let nameIn = $state(typeof stored.name === 'string' ? stored.name : '');
  $effect(() => save(KEY, { client, name: nameIn }));

  const name = $derived(nameIn.trim() || DEFAULT.name);
  const nameErr = $derived(/^[A-Za-z0-9_-]{1,40}$/.test(name) ? '' : 'Use letters, digits, - or _ (max 40).');
  const valid = $derived(!nameErr);
  const commands = $derived<{ id: string; label: string; text: string }[]>(
    client === 'claude'
      ? [
          { id: 'claude', label: 'Run in a terminal', text: `claude mcp add --scope user ${name} -- ${launch}` },
          { id: 'claude-remove', label: 'Had the old hosted getliq? Remove it before adding', text: `claude mcp remove ${name}` }
        ]
      : client === 'codex'
        ? [{ id: 'codex', label: 'Add to ~/.codex/config.toml', text: `[mcp_servers.${name}]\ncommand = "${command}"\nargs = ${JSON.stringify(args)}\nstartup_timeout_sec = 60\nrequired = true` }]
        : [{ id: 'other', label: 'Add a stdio server', text: `name: ${name}\ncommand: ${command}\nargs: ${JSON.stringify(args)}` }]
  );
  const prompt = $derived(setupPrompt(client, name));

  let copied = $state('');
  let failed = $state('');

  async function copy(e: MouseEvent, id: string, text: string) {
    (e.currentTarget as HTMLElement).blur();
    try {
      await navigator.clipboard.writeText(text);
      [copied, failed] = [id, ''];
      setTimeout(() => copied === id && (copied = ''), 1500);
    } catch {
      [copied, failed] = ['', id];
    }
  }
</script>

<div class="connect" data-testid="ai-connect">
  <section class="card">
    <h4>One step</h4>
    <p class="dim">Paste in a terminal on this computer. It adds getliq to Claude Code and Codex when installed, then opens this page and pairs this browser. It runs one pinned revision of a public, read-only gist: <a href={CONNECTOR_SOURCE} target="_blank" rel="noreferrer">read the code</a>.</p>
    <button class="copy-prompt" data-testid="ai-copy-oneshot" onclick={(e) => copy(e, 'oneshot', SETUP_COMMAND)}>{copied === 'oneshot' ? 'Copied setup command' : 'Copy setup command'}</button>
    <pre data-testid="ai-oneshot-command">{SETUP_COMMAND}</pre>
    {#if failed === 'oneshot'}<p class="err" role="status">Copy failed. Select the command instead.</p>{/if}
  </section>
  <section class="card">
    <p class="dim">Setup installs only the local getliq connector. The AI never needs repository access or a source-code path.</p>
    <h4>Or let your AI set it up</h4>
    <button class="copy-prompt" data-testid="ai-copy-setup" disabled={!valid} onclick={(e) => copy(e, 'setup', prompt)}>{copied === 'setup' ? 'Copied setup prompt' : 'Copy setup prompt'}</button>
    <p class="callout">Paste it into your local AI. It only sets up the connection: no orders, wallet, signature or trading key. Desktop only: the AI runs on this computer.</p>
    {#if failed === 'setup'}<p class="err" role="status">Copy failed. Open “Prompt” below and select the text.</p>{/if}
    <div class="fields">
      <label>Client
        <select data-testid="ai-client" bind:value={client}>
          {#each Object.entries(CLIENTS) as [id, label] (id)}<option value={id}>{label}</option>{/each}
        </select>
      </label>
      <label>Server name<input data-testid="ai-server-name" placeholder={DEFAULT.name} bind:value={nameIn} spellcheck="false" autocomplete="off" /></label>
    </div>
    {#if nameErr}<p class="err" role="status" data-testid="ai-connect-error">{nameErr}</p>{/if}
    <details>
      <summary class="dim">Prompt</summary>
      <pre data-testid="ai-setup-prompt">{prompt}</pre>
    </details>
  </section>
  <section class="card">
    <h4>Steps</h4>
    <ol>
      <li>
        <details>
          <summary>Add {name} to {CLIENTS[client]}</summary>
          {#each commands as cmd (cmd.id)}
            <div class="command">
              <div class="row">
                <span class="dim">{cmd.label}</span>
                <button data-testid="ai-copy-{cmd.id}" disabled={!valid} onclick={(e) => copy(e, cmd.id, cmd.text)}>{copied === cmd.id ? 'Copied' : 'Copy'}</button>
              </div>
              <pre data-testid="ai-cmd-{cmd.id}">{cmd.text}</pre>
              {#if failed === cmd.id}<p class="err" role="status">Copy failed. Select the text instead.</p>{/if}
            </div>
          {/each}
          {#if client === 'codex'}<p class="dim">Merge into the file; keep your other settings.</p>{/if}
        </details>
      </li>
      <li>
        <details>
          <summary>Load {name} in {CLIENTS[client]}</summary>
          <p class="dim">It starts getliq itself. Every client on this computer shares one workspace in ~/.getliq/getliq.db. No wallet, signature or allowlist.</p>
        </details>
      </li>
      <li>
        <details>
          <summary>Pair this browser</summary>
          <p class="dim">Ask your AI to call pair_browser, then open its link here or paste the code in Pair code. The browser may ask once to allow access to apps on this device.</p>
        </details>
      </li>
      <li>
        <details>
          <summary>Optional: share chart context</summary>
          <p class="dim">Turn on “Share chart context” in this panel for chart-aware guidance. Off clears the snapshot.</p>
        </details>
      </li>
      <li>
        <details>
          <summary>Ask for mentoring</summary>
          <p class="dim">Try: “Use the mentor prompt and help me practice one trading skill.” Mentoring runs only while your client is open.</p>
        </details>
      </li>
    </ol>
  </section>
  <section class="card">
    <h4>Already on Hyperliquid?</h4>
    <p class="dim">Steps and a prompt to move over.</p>
    <button class="copy-prompt" data-testid="ai-open-migration" onclick={(e) => { e.currentTarget.blur(); ui.overlay = 'migration'; }}>Hyperliquid migration guide</button>
  </section>
</div>

<style>
  .connect { display: flex; flex-direction: column; gap: 10px; }
  .fields { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
  .fields label { display: flex; flex-direction: column; gap: 2px; min-width: 0; color: var(--dim); }
  ol { margin: 0; padding-inline-start: 22px; display: flex; flex-direction: column; gap: 8px; }
  li { min-width: 0; padding-inline-start: 2px; overflow-wrap: anywhere; }
  li::marker { color: var(--dim); font-weight: 600; }
  li summary { color: var(--bright); }
  li details > :not(summary) { margin-top: 4px; }
  .command { display: flex; flex-direction: column; gap: 4px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .row span { min-width: 0; overflow-wrap: anywhere; }
  .row button { flex-shrink: 0; padding: 2px 8px; color: var(--bright); }
  .copy-prompt { align-self: flex-start; max-width: 100%; padding: 6px 10px; color: var(--bright); white-space: normal; }
  summary { cursor: pointer; }
  a { color: var(--accent); }
  details pre { margin-top: 6px; max-height: 220px; overflow: auto; }
  pre {
    margin: 0; padding: 6px 8px; border: 1px solid var(--surface); border-radius: var(--radius); background: var(--bg); color: var(--bright);
    font: max(8px, calc(var(--fs) * 0.917)) / 1.4 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; user-select: all;
  }
  p { margin: 0; }
  .dim { color: var(--dim); }
  .err { color: var(--sell); }
</style>
