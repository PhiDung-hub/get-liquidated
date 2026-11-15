<script lang="ts">
  import { AGENT, connection, type ClientSession } from '$lib/agent/agent.svelte';
  let copyError = $state('');
  let copied = $state('');
  const PROMPT = 'Continue trading mentorship in this getliq workspace. Read setup and mentor resources, then chart_context and mentor_progress. Report this actual local client/session with client_session if its resumable ID is known; do not invent an ID or local port. Publish one bounded lesson with record_observation(kind=advice), including evidence, uncertainty, invalidation and one practice step. Use mark for relevant chart annotations and reply_annotation for chart questions. No orders, execution hotkeys or recurring tasks. Report idle when this turn ends. Keep transcripts, secrets and private reasoning out of session metadata and progress.';
  const sessions = $derived(connection.sessions);
  const calls = $derived(connection.calls);
  const now = $derived(connection.now);
  const error = $derived(copyError || connection.error);
  const age = (at: number) => now - at < 60_000 ? 'just now' : Math.floor(Math.max(0, now - at) / 60_000) + 'm ago';
  const resume = (s: ClientSession) => !s.sessionId ? '' : s.client === 'codex' ? 'codex resume ' + s.sessionId : s.client === 'claude-code' ? 'claude --resume ' + s.sessionId : '';
  async function copy(id: string, value: string) {
    try { await navigator.clipboard.writeText(value); copied = id; }
    catch { copyError = 'Copy failed. Select the text and copy it manually.'; }
  }
</script>

<div id="ai-connection" class="connection" data-testid="ai-connection">
  <section class="card">
    <h4>Local AI connection</h4>
    <p class="dim">Your conversation runs in Codex or Claude on this computer; this browser shows what it publishes. Nothing is stored in the cloud.</p>
    <details>
      <summary>Endpoint details</summary>
      <p data-testid="ai-endpoint">Companion <code>{AGENT}</code> (loopback only) · MCP over stdio · data <code>~/.getliq/getliq.db</code></p>
    </details>
  </section>
  <section class="card">
    <h4>Client sessions</h4>
    {#each sessions as session (session.client + ':' + (session.sessionId ?? ''))}
      <article data-testid="ai-client-session">
        <strong>{session.client === 'codex' ? 'Codex' : session.client === 'claude-code' ? 'Claude Code' : 'Local MCP client'}</strong>
        <p class="dim">{now - session.at < 90_000 ? 'Reported ' + session.status : 'Activity unknown'} · last report {age(session.at)}</p>
        {#if session.sessionId}<code data-testid="ai-session-id">{session.sessionId}</code>{:else}<p class="dim">Resumable session ID not reported.</p>{/if}
        {#if resume(session)}
          <code data-testid="ai-resume-command">{resume(session)}</code>
          <button data-testid="ai-copy-resume" onclick={() => copy(resume(session), resume(session))}>{copied === resume(session) ? 'Copied' : 'Copy resume command'}</button>
        {/if}
        {#if session.localUrl}<a href={session.localUrl} target="_blank" rel="noreferrer">Open reported local UI · port {new URL(session.localUrl).port || (session.localUrl.startsWith('https:') ? '443' : '80')}</a>{/if}
      </article>
    {:else}
      <p class="dim" data-testid="ai-client-unreported">No local session has reported its identity. Paste the mentor request into your Codex or Claude conversation.</p>
    {/each}
  </section>
  <section class="card">
    <h4>Mentor request</h4>
    <button data-testid="ai-copy-mentor" onclick={() => copy('mentor', PROMPT)}>{copied === 'mentor' ? 'Copied mentor request' : 'Copy mentor request'}</button>
    <details>
      <summary>Read mentor request</summary><pre>{PROMPT}</pre>
    </details>
  </section>
  <section class="card">
    <details data-testid="ai-tool-log">
      <summary>Tool activity · {calls.length ? age(calls[0].at) : 'no calls recorded'}</summary>
      <p class="dim">Latest 30 calls across this workspace · refreshes every 15s. Arguments, transcripts and private reasoning are not logged. A past call does not mean a client is still running.</p>
      <ol>
        {#each calls as call (call.id)}
          <li data-testid="ai-tool-call"><time title={new Date(call.at).toISOString()}>{age(call.at)}</time> <code>{call.tool}</code> <span class:failed={call.status === 'error'}>{call.status}</span> · {call.durationMs}ms</li>
        {:else}<li>No MCP calls recorded yet.</li>{/each}
      </ol>
    </details>
  </section>
  {#if error}<p class="failed" role="status" data-testid="ai-connection-error">{error}</p>{/if}
</div>

<style>
  .connection, article { display: flex; flex-direction: column; gap: 10px; min-width: 0; overflow-wrap: anywhere; }
  article { gap: 6px; }
  article + article { padding-top: 8px; border-top: 1px solid var(--line); }
  details > :not(summary) { margin-top: 6px; }
  p { margin: 0; }
  code, pre { font-family: var(--mono); font-size: max(8px, .917em); }
  pre { white-space: pre-wrap; max-height: 200px; overflow: auto; }
  button { align-self: flex-start; }
  summary { cursor: pointer; color: var(--bright); }
  ol { padding-left: 18px; max-height: 240px; overflow-y: auto; }
  li { margin-top: 6px; }
  .dim, time { color: var(--dim); }
  .failed { color: var(--sell); }
  a { color: var(--accent); }
</style>
