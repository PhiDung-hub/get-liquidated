<script lang="ts">
  import { agent, connection, sendTerminal, terminalSessions, WAKE } from '$lib/agent/agent.svelte';
  let target = $state('');
  let selectedOnce = $state(false);
  let message = $state('');
  let sending = $state(false);
  let error = $state('');
  let retry = $state<{ id: string; client: 'codex' | 'claude-code'; sessionId: string; message: string } | null>(null);
  const sessions = $derived(terminalSessions());
  const selected = $derived(sessions.find((s) => `${s.client}:${s.sessionId}` === target));
  const waiting = $derived(agent.commands.some((c) => `${c.client}:${c.sessionId}` === target && connection.now - c.created < 180_000 && ['sending', 'sent', 'received'].includes(c.status)));
  const statuses = { sending: 'Sending to terminal', sent: 'Sent to terminal · awaiting AI', received: 'Read by AI · awaiting reply', replied: 'Replied', failed: 'Delivery unconfirmed' };
  $effect(() => {
    if (target) selectedOnce = true;
    else if (!selectedOnce && sessions.length === 1) {
      target = `${sessions[0].client}:${sessions[0].sessionId}`;
      selectedOnce = true;
    }
  });
  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!selected || sending || waiting || !message.trim()) return;
    sending = true;
    error = '';
    const input = { client: selected.client as 'codex' | 'claude-code', sessionId: selected.sessionId!, message: message.trim() };
    const id = retry && retry.client === input.client && retry.sessionId === input.sessionId && retry.message === input.message ? retry.id : crypto.randomUUID();
    retry = { ...input, id };
    try {
      await sendTerminal(retry);
      message = '';
      retry = null;
    } catch (e) { error = (e as Error).message; }
    finally { sending = false; }
  }
</script>

<section class="terminal" data-testid="ai-terminal" aria-label="AI terminal">
  {#if !sessions.length}
    <p class="dim" data-testid="ai-terminal-unavailable" title="Needs getliq 0.6.0 or later. Start your AI in Agent OS and ask it to report client_session with its session ID and terminal: true.">No terminal session yet.</p>
  {:else}
    <form onsubmit={submit} title="Sends a prompt to your running local AI through getliq and Agent OS. It uses that session’s permissions; check the local terminal for approvals. Prompts and replies are kept on this computer for 24 hours. Never include secrets.">
      {#if sessions.length > 1 || !selected}
        <select class="ui-field" aria-label="Destination session" bind:value={target} disabled={sending} data-testid="ai-terminal-session">
          <option value="">Choose a session</option>
          {#each sessions as session (session.client + ':' + session.sessionId)}
            <option value={`${session.client}:${session.sessionId}`}>{session.client === 'codex' ? 'Codex' : 'Claude Code'} · {session.sessionId} · reported {session.status}</option>
          {/each}
        </select>
      {/if}
      {#if selected}<code class="dim" data-testid="ai-terminal-destination">{selected.client} · {selected.sessionId}</code>{/if}
      <textarea class="ui-field" aria-label="Prompt" data-testid="ai-terminal-input" bind:value={message} maxlength="2000" rows="2" placeholder="Prompt your running AI…" disabled={!selected || sending || agent.status !== 'live'}></textarea>
      <button data-testid="ai-terminal-send" disabled={!selected || sending || waiting || agent.status !== 'live' || !message.trim()}>{sending ? 'Sending…' : 'Send'}</button>
      {#if waiting}<p class="dim">Awaiting a reply. Check the local terminal for approvals.</p>{/if}
    </form>
  {/if}
  {#if error}<p class="error" role="status" data-testid="ai-terminal-error">{error}</p>{/if}
  <ol aria-label="Terminal command history">
    {#each agent.commands as command (command.id)}
      <li data-testid="ai-terminal-command">
        <p class="dim">{command.client} · {command.sessionId} · <time datetime={new Date(command.created).toISOString()}>{new Date(command.created).toLocaleTimeString()}</time></p>
        <p class="text" title={command.message.startsWith(WAKE) ? command.message : undefined}>{command.message.startsWith(WAKE) ? 'Chart question' : command.message}</p>
        <p class="dim" role="status">{statuses[command.status]}</p>
        {#if command.error}<p class="error">{command.error}</p>{/if}
        {#if command.reply}<p class="text" data-testid="ai-terminal-reply">{command.reply}</p>{/if}
      </li>
    {/each}
  </ol>
</section>

<style>
  .terminal, form { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  p, ol { margin: 0; }
  select, textarea { width: 100%; min-width: 0; }
  textarea { resize: vertical; }
  button { align-self: flex-start; }
  code { font-family: var(--mono); }
  code, p { overflow-wrap: anywhere; }
  .text { white-space: pre-wrap; }
  .dim { color: var(--dim); }
  .error { color: var(--sell); }
  ol { list-style: none; padding: 0; max-height: 360px; overflow-y: auto; }
  li { display: flex; flex-direction: column; gap: 6px; padding: 8px 0; }
  li + li { border-top: 1px solid var(--line); }
</style>
