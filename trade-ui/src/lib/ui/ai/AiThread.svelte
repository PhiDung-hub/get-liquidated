<script module lang="ts">
  const composer = $state({ draft: '', target: '' });
</script>

<script lang="ts">
  import { agent, annotationChat, askBlocked, askNow, connection, copyRequest, sendTerminal, terminalSessions, WAKE, type Advice, type Mark, type Suggestion } from '$lib/agent/agent.svelte';
  import { market } from '$lib/market/market.svelte';
  import { meta } from '$lib/market/meta.svelte';
  import { fmtPx } from '$lib/util/format';
  import SuggestionCard from './SuggestionCard.svelte';

  type Message = (typeof agent.chats)[number]['messages'][number];
  type Command = (typeof agent.commands)[number];
  type ChatRow = { kind: 'chat'; key: string; at: number; mark: Mark; message: Message };
  type Row = ChatRow
    | { kind: 'command'; key: string; at: number; command: Command }
    | { kind: 'advice'; key: string; at: number; entry: Advice }
    | { kind: 'ticket'; key: string; at: number; s: Suggestion }
    | { kind: 'mark'; key: string; at: number; mark: Mark };
  type Segment = { kind: 'text' | 'pre' | 'code' | 'strong'; text: string };

  const OPEN = ['sending', 'sent', 'received'];
  const statuses = { sending: 'Sending to terminal', sent: 'Sent to terminal · awaiting AI', received: 'Read by AI · awaiting reply', replied: 'Replied', failed: 'Delivery unconfirmed' };
  const finite = (t: unknown) => (Number.isFinite(t) ? (t as number) : 0);
  const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const price = (mark: Mark, px: number) => fmtPx(px, meta.byName.get(mark.coin)?.szDecimals);

  /** AI text as plain nodes: fenced blocks, backtick spans and **bold** only, so nothing it writes becomes a link, an image or markup. */
  function segments(text: string): Segment[] {
    const out: Segment[] = [];
    let from = 0;
    for (const m of text.matchAll(/```(?:[^\n`]*\n)?([\s\S]*?)```|`([^`\n]+)`|\*\*([^*\n]+)\*\*/g)) {
      if (m.index > from) out.push({ kind: 'text', text: text.slice(from, m.index) });
      out.push(m[1] !== undefined ? { kind: 'pre', text: m[1] } : m[2] !== undefined ? { kind: 'code', text: m[2] } : { kind: 'strong', text: m[3] });
      from = m.index + m[0].length;
    }
    if (from < text.length) out.push({ kind: 'text', text: text.slice(from) });
    return out;
  }

  const rows = $derived<Row[]>([
    ...agent.chats.filter((c) => c.mark.coin === market.coin).flatMap((c) => c.messages.map((message): Row => ({ kind: 'chat', key: `c:${c.mark.id}:${message.id}`, at: message.created, mark: c.mark, message }))),
    ...agent.commands.filter((c) => !c.message.startsWith(WAKE)).map((command): Row => ({ kind: 'command', key: `t:${command.id}`, at: command.created, command })),
    ...agent.advice.filter((entry) => !entry.coin || entry.coin === market.coin).map((entry): Row => ({ kind: 'advice', key: `a:${entry.id}`, at: entry.created, entry })),
    ...agent.suggestions.map((s): Row => ({ kind: 'ticket', key: `s:${s.id}`, at: s.created, s })),
    ...agent.marks.filter((mark) => mark.coin === market.coin && mark.author !== 'user').map((mark): Row => ({ kind: 'mark', key: `m:${mark.id}`, at: finite(mark.created), mark }))
  ].sort((a, b) => a.at - b.at));
  const chatRows = $derived(rows.filter((row): row is ChatRow => row.kind === 'chat'));
  const anchors = $derived(new Set(chatRows.filter((row, i) => row.mark.id !== chatRows[i - 1]?.mark.id).map((row) => row.key)));
  const sent = $derived(rows.flatMap((row) => (row.kind === 'command' ? [row.command.message] : row.kind === 'chat' && row.message.role === 'user' ? [row.message.text] : [])));
  function anchor(mark: Mark) {
    if (mark.author !== 'user' || mark.a === null) return mark.type;
    if (mark.type === 'zone' && mark.b !== null) return `your zone ${price(mark, mark.a)} – ${price(mark, mark.b)}`;
    return `your point ${price(mark, mark.a)}${mark.interval ? ` · ${mark.interval}` : ''}`;
  }

  const pending = $derived.by(() => {
    const last = chatRows.at(-1);
    return last?.message.role === 'user' && !chatRows.some((row) => row.message.replyTo === last.message.id) ? last : undefined;
  });
  const woken = $derived(pending && agent.commands.find((c) => c.message.startsWith(WAKE) && c.message.includes(`markId ${pending.mark.id} `) && OPEN.includes(c.status) && c.created >= pending.at && connection.now - c.created < 180_000));
  const answering = $derived(!!pending && !!agent.answerer?.answering.includes(pending.mark.id));
  const status = $derived(answering ? 'Claude Code is answering…' : agent.answerer ? 'Waiting for Claude Code to answer.' : woken ? `Sent to ${woken.client} · ${woken.sessionId}. Its reply appears here.` : 'Waiting for your local AI client to read and reply.');
  let now = $state(Date.now());
  $effect(() => {
    const t = setInterval(() => (now = Date.now()), answering ? 1000 : 15_000);
    return () => clearInterval(t);
  });
  let copied = $state('');
  async function copy(mark: Mark) {
    try {
      await navigator.clipboard.writeText(copyRequest(mark));
      copied = mark.id;
    } catch { error = `Clipboard unavailable. Ask your connected client to read annotation_chat for this annotation: ${mark.id}`; }
  }

  let log = $state<HTMLOListElement>();
  let stuck = true;
  $effect(() => {
    void [rows, pending, status];
    if (log && stuck) log.scrollTop = log.scrollHeight;
  });

  const sessions = $derived(terminalSessions());
  const session = $derived(sessions.find((s) => `${s.client}:${s.sessionId}` === composer.target));
  const gone = $derived(!!composer.target && !session);
  const blocked = $derived(composer.target ? '' : askBlocked());
  const waiting = $derived(!!composer.target && agent.commands.some((c) => `${c.client}:${c.sessionId}` === composer.target && connection.now - c.created < 180_000 && OPEN.includes(c.status)));
  const cap = $derived(composer.target ? 2000 : 1000);
  let sending = $state(false);
  let error = $state('');
  const disabled = $derived(!composer.draft.trim() || composer.draft.length > cap || sending || !!blocked || gone || waiting || (!!composer.target && agent.status !== 'live'));
  $effect(() => {
    void [composer.draft, composer.target, gone, blocked];
    error = '';
  });
  let retry: { id: string; client: 'codex' | 'claude-code'; sessionId: string; message: string } | null = null;
  /** A resend of the same prompt to the same session keeps its id, so the companion delivers it once. */
  function prompt(message: string) {
    const input = { client: session!.client as 'codex' | 'claude-code', sessionId: session!.sessionId!, message };
    const same = retry && retry.client === input.client && retry.sessionId === input.sessionId && retry.message === message;
    return (retry = { ...input, id: same ? retry!.id : crypto.randomUUID() });
  }
  async function send() {
    if (disabled) return;
    const message = composer.draft.trim();
    [sending, error] = [true, ''];
    try {
      if (session) {
        await sendTerminal(prompt(message));
        retry = null;
      } else await askNow(message);
      if (composer.draft.trim() === message) [composer.draft, browsing] = ['', -1];
      stuck = true;
    } catch (e) { error = (e as Error).message; }
    finally { sending = false; }
  }

  let browsing = -1;
  function keys(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      return void send();
    }
    if (!['ArrowUp', 'ArrowDown'].includes(e.key) || (browsing < 0 && (e.key === 'ArrowDown' || composer.draft))) return;
    const i = (browsing < 0 ? sent.length : browsing) + (e.key === 'ArrowUp' ? -1 : 1);
    if (i < 0) return;
    e.preventDefault();
    browsing = i < sent.length ? i : -1;
    composer.draft = sent[i] ?? '';
  }
  let box = $state<HTMLTextAreaElement>();
  $effect(() => {
    void composer.draft;
    if (!box) return;
    const pin = stuck;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight + 2}px`;
    if (pin && log) log.scrollTop = log.scrollHeight;
  });
</script>

{#snippet rich(text: string)}{#each segments(text) as part}{#if part.kind === 'pre'}<pre><code>{part.text}</code></pre>{:else if part.kind === 'code'}<code>{part.text}</code>{:else if part.kind === 'strong'}<strong>{part.text}</strong>{:else}{part.text}{/if}{/each}{/snippet}

{#snippet chatRow(row: ChatRow)}
  <li>
    {#if anchors.has(row.key)}<button class="link" data-testid="ai-thread-anchor" title="Open this thread on the chart" onclick={() => (annotationChat.markId = row.mark.id)}>{anchor(row.mark)}</button>{/if}
    {#if row.message.role === 'user'}
      <small class="you">❯ you · {clock(row.at)}</small><p>{row.message.text}</p>
    {:else}
      <small>◆ mentor · {clock(row.at)}</small><p class="reply">{@render rich(row.message.text)}</p>
    {/if}
  </li>
{/snippet}

{#snippet commandRow(command: Command)}
  <li data-testid="ai-terminal-command">
    <small class="you">❯ you → {command.client} · {command.sessionId} · <time datetime={new Date(command.created).toISOString()}>{clock(command.created)}</time></small>
    <p>{command.message}</p>
    <small role="status">{statuses[command.status]}</small>
    {#if command.error}<p class="err">{command.error}</p>{/if}
    {#if command.reply}<p class="reply" data-testid="ai-terminal-reply">{@render rich(command.reply)}</p>{/if}
  </li>
{/snippet}

<ol class="thread" data-testid="ai-thread" role="log" aria-live="polite" aria-label="Co-pilot conversation" bind:this={log} onscroll={() => (stuck = !!log && log.scrollHeight - log.scrollTop - log.clientHeight < 40)}>
  {#each rows as row (row.key)}
    {#if row.kind === 'chat'}{@render chatRow(row)}
    {:else if row.kind === 'command'}{@render commandRow(row.command)}
    {:else if row.kind === 'ticket'}<li><SuggestionCard s={row.s} {now} /></li>
    {:else if row.kind === 'mark'}
      <li><small>◇ {row.mark.type}{row.mark.a !== null ? ` ${price(row.mark, row.mark.a)}` : ''}</small><button class="link" data-testid="ai-discuss-mark" onclick={() => (annotationChat.markId = row.mark.id)}>Discuss: {row.mark.label}</button></li>
    {:else}
      <li><article data-testid="ai-advice">
        <strong>{row.entry.skill}</strong>
        <p>{row.entry.advice}</p>
        <p class="dim">Practice: {row.entry.nextStep}</p>
        <details><summary>Evidence &amp; reasoning summary{row.entry.stage ? ` · ${row.entry.stage.replaceAll('-', ' ')}` : ''}</summary><p class="dim">{row.entry.evidence}</p></details>
      </article></li>
    {/if}
  {:else}
    <li class="dim" data-testid="ai-empty">Nothing yet. Ask below, or run /mcp__getliq__mentor in Claude Code.</li>
  {/each}
</ol>
{#if pending}
  <p class="dim" data-testid="ai-waiting" role="status">{status}{#if answering}<span aria-hidden="true"> {Math.max(0, Math.round((now - pending.at) / 1000))}s</span>{/if}
    {#if !agent.answerer && !woken}<button class="link" data-testid="ai-copy-request" onclick={() => copy(pending.mark)}>{copied === pending.mark.id ? 'Copied — paste into your AI client' : 'Copy request for Codex / Claude'}</button>{/if}
  </p>
{/if}
<form data-testid="ai-composer" onsubmit={(e) => (e.preventDefault(), void send())}>
  <div class="line">
    <textarea data-testid="ai-ask" rows="1" aria-label={session ? 'Prompt' : `Question about ${market.coin}`} bind:this={box} bind:value={composer.draft} placeholder={composer.target ? 'Prompt your running AI…' : `Ask about ${market.coin}…`} maxlength={cap} disabled={!!blocked} title={blocked} onkeydown={keys} oninput={() => (browsing = -1)}></textarea>
    <button class="send" data-testid="ai-ask-send" {disabled}>{sending ? 'Sending…' : 'Send'}</button>
  </div>
  <div class="foot">
  {#if sessions.length || composer.target}
    <select data-testid="ai-terminal-session" aria-label="Send to" bind:value={composer.target} disabled={sending} title="A session takes the prompt through getliq and Agent OS with that session’s permissions; check the local terminal for approvals. Prompts and replies are kept on this computer for 24 hours. Never include secrets.">
      <option value="">Chart · {market.coin}</option>
      {#each sessions as s (s.client + ':' + s.sessionId)}
        <option value={`${s.client}:${s.sessionId}`}>{s.client === 'codex' ? 'Codex' : 'Claude Code'} · {s.sessionId} · reported {s.status}</option>
      {/each}
    </select>
  {/if}
  {#if error}<p class="err" role="status" data-testid="ai-ask-error">{error}</p>
  {:else if blocked && agent.status === 'live'}<p class="warn" data-testid="ai-client">{blocked}</p>
  {:else if gone}<p class="warn">That session is gone. Pick where to send this.</p>
  {:else if composer.draft.length > cap}<p class="warn">{composer.draft.length} / {cap} characters. Shorten it to send.</p>
  {:else if waiting}<p class="dim">Awaiting a reply. Check the local terminal for approvals.</p>
  {:else}<p class="dim hints">⏎ send · ⇧⏎ newline · ↑ last</p>{/if}
  </div>
</form>

<style>
  .thread { flex: 1; min-height: 4lh; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
  li { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; }
  li > :global(*) { max-width: 100%; }
  p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  small { color: var(--dim); font-family: var(--mono); font-size: max(8px, calc(var(--fs) * 0.917)); overflow-wrap: anywhere; }
  .you, .link { color: var(--accent); }
  .link { padding: 0; background: none; text-align: left; }
  .reply { color: var(--bright); }
  code, pre { font-family: var(--mono); }
  pre { margin: 4px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  article { align-self: stretch; border: 1px solid var(--surface); border-radius: var(--radius); padding: 10px; display: flex; flex-direction: column; gap: 8px; overflow-wrap: anywhere; }
  summary { cursor: pointer; color: var(--dim); margin-bottom: 8px; }
  form { position: sticky; bottom: -10px; flex-shrink: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0; padding-bottom: 10px; margin-bottom: -10px; background: var(--panel); }
  .foot { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
  .foot p { flex: 1 1 12ch; min-width: 0; }
  .line { display: flex; align-items: flex-end; gap: 8px; }
  textarea { flex: 1; min-width: 0; box-sizing: border-box; resize: none; max-height: min(8lh, 25vh); overflow-y: auto; }
  select { flex: 0 1 auto; min-width: 0; max-width: 55%; }
  .send { height: var(--ctl); padding: 0 14px; background: var(--accent); color: var(--bg); }
  .hints { font-size: max(8px, calc(var(--fs) * 0.917)); }
  .dim { color: var(--dim); }
  .warn { color: var(--warn); }
  .err { color: var(--sell); }
</style>
