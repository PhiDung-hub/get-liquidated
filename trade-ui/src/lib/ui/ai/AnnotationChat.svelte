<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { agent, annotationChat, askAnnotation, askBlocked, askSelection, copyRequest, deleteMark, terminalSessions, wakeSession, type Selection } from '$lib/agent/agent.svelte';
  import { market } from '$lib/market/market.svelte';
  import { meta } from '$lib/market/meta.svelte';
  import { fmtPx } from '$lib/util/format';
  import { isTouch } from '$lib/ui/touch';
  import { drawings } from '$lib/ui/chart/drawings.svelte';
  import AiMessage from './AiMessage.svelte';
  import { load, save } from '$lib/util/storage';
  import { included, type SelectionContext } from '$lib/ui/chart/selection';

  let { time = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' '), dock = (): 'top' | 'bottom' => 'bottom', collect }: { time?: (t: number) => string; dock?: (price: number) => 'top' | 'bottom'; collect?: (sel: Selection) => SelectionContext } = $props();

  const thread = $derived(agent.chats.find((chat) => chat.mark.id === annotationChat.markId));
  const sel = $derived(annotationChat.markId ? null : annotationChat.pending);
  const mark = $derived(agent.marks.find((mark) => mark.id === annotationChat.markId) ?? thread?.mark ?? (sel && { id: '', coin: sel.coin, type: sel.type, a: sel.a, b: sel.b ?? null, label: sel.type === 'zone' ? 'Selected zone' : 'Selected point', author: 'user' as const, interval: sel.interval, t0: sel.t0, t1: sel.t1, created: 0, expires: 0 }));
  const active = $derived(!!sel || agent.marks.some((mark) => mark.id === annotationChat.markId));
  const blocked = $derived(sel ? askBlocked() : '');
  const context = $derived(sel && collect ? collect(sel) : undefined);
  const includes = $derived(context ? included(context) : '');
  const shown = $derived(!!mark && mark.coin === market.coin && !!agent.address);
  const side = $derived(mark?.a == null ? 'bottom' : dock(mark.b == null ? mark.a : (mark.a + mark.b) / 2));
  const when = $derived(mark?.t0 ? `${mark.interval ?? ''} · ${time(mark.t0)}${mark.t1 && mark.t1 !== mark.t0 ? ` → ${time(mark.t1)}` : ''}` : '');
  let deleting = $state(false);
  const decimals = $derived(mark ? meta.byName.get(mark.coin)?.szDecimals : undefined);
  const pending = $derived(thread?.messages.filter((message) => message.role === 'user' && !thread.messages.some((reply) => reply.replyTo === message.id)) ?? []);
  const PROMPTS = ['What does this show?', 'What would invalidate it?', 'Where is my risk here?'];
  let now = $state(Date.now());
  $effect(() => {
    if (!pending.length) return;
    now = Date.now();
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const waited = $derived(pending.length ? Math.max(0, Math.round((now - pending[0].created) / 1000)) : 0);
  /** The thread a running local session was asked to answer, so its question needs no copy and paste. */
  let woke = $state('');
  async function wake(id: string) {
    if (agent.answerer || !terminalSessions().length) return;
    // A refused hand-off leaves the copy request below, which says how to ask the client by hand.
    if (await wakeSession(id).catch(() => false)) woke = id;
  }
  let draft = $state('');
  const SIZE = 'trade-ui:chat-size';
  let size = $state(load(SIZE, { w: 0, h: 0 }));
  let grip: { x: number; y: number; w: number; h: number } | null = null;
  const keep = (next: { w: number; h: number }) => save(SIZE, (size = next));
  function gripDown(e: PointerEvent) {
    const box = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    grip = { x: e.clientX, y: e.clientY, w: box.width, h: box.height };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function gripMove(e: PointerEvent) {
    if (grip) size = { w: Math.max(300, Math.round(grip.w + grip.x - e.clientX)), h: Math.max(280, Math.round(grip.h + (side === 'top' ? e.clientY - grip.y : grip.y - e.clientY))) };
  }
  function gripUp() {
    if (grip) keep(size);
    grip = null;
  }
  let sending = $state(false);
  let error = $state('');
  let copied = $state(false);
  let input = $state<HTMLTextAreaElement>();
  type Dictation = {
    lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
    onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
    onerror: ((event: { error: string }) => void) | null;
    onend: (() => void) | null;
    start(): void; stop(): void; abort(): void;
  };
  let Recognition: (new () => Dictation) | undefined;
  let recognition: Dictation | null = null;
  let voiceSupported = $state(false);
  let listening = $state(false);
  onMount(() => {
    const browser = window as typeof window & { SpeechRecognition?: typeof Recognition; webkitSpeechRecognition?: typeof Recognition };
    Recognition = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    voiceSupported = !!Recognition;
    return cancelVoice;
  });
  function cancelVoice() {
    const current = recognition;
    recognition = null;
    listening = false;
    if (!current) return;
    current.onresult = current.onerror = current.onend = null;
    try { current.abort(); }
    catch (e) { console.warn('Could not stop browser voice input', e); }
  }
  function voice() {
    error = '';
    if (listening) {
      try { recognition?.stop(); }
      catch { cancelVoice(); error = 'Voice input could not finish. Review your text and try Voice again.'; }
      return;
    }
    if (!Recognition || !active || sending || draft.length >= 1000) return;
    const base = draft.trim();
    try {
      const current = new Recognition();
      recognition = current;
      current.lang = navigator.language || 'en-US';
      current.continuous = current.interimResults = true;
      current.maxAlternatives = 1;
      current.onresult = (event) => {
        if (recognition !== current) return;
        try {
          const text = Array.from(event.results, (result) => {
            if (typeof result?.[0]?.transcript !== 'string') throw new Error('Invalid speech result');
            return result[0].transcript;
          }).join(' ').trim();
          draft = [base, text].filter(Boolean).join(' ').slice(0, 1000);
        } catch {
          cancelVoice();
          error = 'Voice input returned an invalid transcript. Try Voice again, or type your question.';
        }
      };
      current.onerror = (event) => {
        if (recognition !== current) return;
        cancelVoice();
        error = ['not-allowed', 'service-not-allowed'].includes(event.error)
          ? 'Microphone access was denied. Allow microphone access in your browser site settings, then try Voice again.'
          : event.error === 'audio-capture' ? 'No microphone is available. Check your microphone connection and browser settings.'
          : event.error === 'no-speech' ? 'No speech was detected. Try Voice again, or type your question.'
          : 'Voice input failed. Check your connection and try Voice again, or type your question.';
      };
      current.onend = () => {
        if (recognition !== current) return;
        recognition = null;
        listening = false;
      };
      listening = true;
      current.start();
    } catch {
      cancelVoice();
      error = 'Voice input could not start. Check microphone access in your browser site settings, or type your question.';
    }
  }
  function close(refocus = true) {
    const id = annotationChat.markId;
    Object.assign(annotationChat, { markId: null, pending: null });
    if (id && refocus) document.querySelector<HTMLButtonElement>(`[data-testid="chart"] [data-key="${CSS.escape(id)}"]`)?.focus();
  }
  $effect(() => {
    const id = annotationChat.markId ?? (annotationChat.pending && 'pending');
    draft = '';
    error = '';
    copied = false;
    // A phone keyboard would cover the chart and the selection the moment the panel opens.
    if (id && !isTouch()) void tick().then(() => input?.focus());
    return cancelVoice;
  });
  $effect(() => { if (shown && active && !sending) return cancelVoice; });
  /** A tap or click (moved under 6px) outside the panel closes it; a drag (a pan) keeps it, as do the controls that open a chat or pick on the chart. */
  const KEEP = '.annotation-chat, [data-testid=ask-ai], [data-testid=ask-selected], .tag.ai, .bias, .copilot';
  let press: { x: number; y: number } | null = null;
  // A typed but unsent question keeps the chat open; × and Esc still close it.
  const down = (e: PointerEvent) => void (press = shown && e.isPrimary && !draft.trim() && drawings.tool !== 'ask' && !(e.target as Element).closest?.(KEEP) ? { x: e.clientX, y: e.clientY } : null);
  const up = (e: PointerEvent) => {
    if (press && shown && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) close(false);
    press = null;
  };
  async function send(message = draft.trim()) {
    if (!mark || sending || listening || blocked || !message) return;
    const id = mark.id;
    const asked = annotationChat.markId ?? annotationChat.pending;
    sending = true;
    error = '';
    try {
      if (sel) {
        const created = await askSelection(sel, message, context);
        if (annotationChat.pending === sel) Object.assign(annotationChat, { markId: created.id, pending: null });
        void wake(created.id);
        return;
      }
      await askAnnotation(id, message);
      void wake(id);
      if (annotationChat.markId === id) { draft = ''; copied = false; }
    } catch (e) {
      if ((annotationChat.markId ?? annotationChat.pending) === asked) error = (e as Error).message;
    } finally { sending = false; }
  }
  async function remove() {
    if (!mark?.id || deleting) return;
    deleting = true;
    error = '';
    try { await deleteMark(mark.id); }
    catch (e) { error = `Delete failed: ${(e as Error).message}`; }
    finally { deleting = false; }
  }
  async function copy() {
    if (!mark) return;
    try {
      await navigator.clipboard.writeText(copyRequest(mark));
      copied = true;
    } catch { error = 'Clipboard unavailable. Ask your connected client to read annotation_chat for this annotation: ' + mark.id; }
  }
</script>

<svelte:window onpointerdowncapture={down} onpointerupcapture={up} />
<svelte:document onvisibilitychange={() => document.hidden && cancelVoice()} />

{#if mark && shown}
  <div class="annotation-chat" class:top={side === 'top'} class:sized={!!size.h} style:--aw={size.w ? `${size.w}px` : null} style:--ah={size.h ? `${size.h}px` : null} data-testid="annotation-chat" data-side={side} role="dialog" tabindex="-1" aria-label="Chat about annotation" onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Escape') close(); }}>
    <header><div><small>{mark.coin} · {mark.author === 'user' ? (mark.type === 'zone' ? 'your zone' : 'your point') : mark.type}</small><strong>{mark.label}</strong></div><button aria-label="Close annotation chat" onclick={() => close()}>×</button></header>
    <span class="grip" data-testid="annotation-grip" role="presentation" title="Drag to resize, double-click to reset" onpointerdown={gripDown} onpointermove={gripMove} onpointerup={gripUp} onpointercancel={gripUp} ondblclick={() => keep({ w: 0, h: 0 })}></span>
    {#if mark.a !== null}<p class="prices" data-testid="annotation-prices">{fmtPx(mark.a, decimals)}{mark.b !== null ? ` – ${fmtPx(mark.b, decimals)}` : ''}</p>{/if}
    {#if when}<small class="dim" data-testid="annotation-when">{when}</small>{/if}
    {#if includes}<small class="dim" data-testid="annotation-included">Included: {includes}</small>{/if}
    <div class="messages" aria-live="polite" role="log" aria-label="Annotation conversation">
      {#each thread?.messages ?? [] as message (message.id)}
        <AiMessage at={message.created} ai={message.role === 'assistant'} text={message.text} />
      {:else}<p class="dim">{sel ? 'Ask your local AI about this selection. Nothing is saved until you send.' : 'Ask about the reasoning, confirmation, or invalidation for this annotation.'}</p>{/each}
    </div>
    {#if pending.length}
      {@const answering = !!agent.answerer?.answering.includes(mark?.id ?? '')}
      {@const handed = !agent.answerer && woke === mark?.id}
      <div class="waiting"><p class="dim" data-testid="annotation-waiting">{answering ? 'Claude Code is answering…' : agent.answerer ? (agent.answerer.error ?? 'Waiting for Claude Code to answer.') : handed ? 'Sent to your running AI session. Its reply appears here.' : 'Waiting for your local AI client to read and reply.'}</p><small data-testid="annotation-elapsed">{waited}s</small></div>
      {#if !answering && !handed}<button data-testid="annotation-copy" onclick={copy}>{copied ? 'Copied — paste into your AI client' : 'Copy request for Codex / Claude'}</button>{/if}
    {/if}
    {#if blocked}<p class="dim" data-testid="annotation-blocked">{blocked}</p>{/if}
    {#if !active}<p class="dim">Annotation expired or removed. Request a fresh annotation before asking more.</p>{/if}
    <form onsubmit={(e) => { e.preventDefault(); void send(); }}>
      {#if active && !blocked && !thread?.messages.length}
        <div class="quick" data-testid="annotation-quick">{#each PROMPTS as q (q)}<button type="button" disabled={sending} onclick={() => send(q)}>{q}</button>{/each}</div>
      {/if}
      <textarea bind:this={input} bind:value={draft} aria-label="Question about this annotation" placeholder="What would confirm this setup?" title="Enter sends, Shift+Enter adds a line. Threads expire after 24 hours idle; don’t send secrets." maxlength="1000" rows="2" disabled={!active || sending || listening}
        onkeydown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch()) { e.preventDefault(); void send(); } }}></textarea>
      <div class="actions">
        {#if sel}<button type="button" data-testid="annotation-cancel" onclick={() => close()}>Cancel</button>
        {:else if mark.id}<button type="button" class="delete" data-testid="annotation-delete" disabled={deleting} onclick={remove}>{deleting ? 'Deleting…' : 'Delete'}</button>{/if}
        <button type="button" data-testid="annotation-voice" aria-label={listening ? 'Stop voice input' : 'Start voice input'} aria-pressed={listening} aria-describedby={voiceSupported ? undefined : 'annotation-voice-help'} title={voiceSupported ? 'Starts only when you press it. Your browser may send audio to its speech service.' : undefined} disabled={!voiceSupported || !active || sending || (!listening && draft.length >= 1000)} onclick={voice}>{listening ? 'Stop' : 'Voice'}</button>
        <button data-testid="annotation-send" disabled={!active || sending || listening || !!blocked || !draft.trim()}>{sending ? 'Sending…' : 'Send'}</button>
      </div>
      {#if listening}<small role="status">Listening… Stop to review your text before sending.</small>{/if}
      {#if !voiceSupported}<small id="annotation-voice-help" class="dim">Voice input is unavailable in this browser. You can still type your question.</small>{/if}
    </form>
    {#if error}<p role="alert" class="error">{error}</p>{/if}
  </div>
{/if}

<style>
  .annotation-chat { position: absolute; z-index: 8; right: 12px; bottom: 32px; width: min(var(--aw, 380px), calc(100% - 24px)); height: var(--ah, auto); max-height: min(520px, calc(100% - 48px)); overflow: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 10px; padding: 0 16px 16px; box-sizing: border-box; background: var(--panel); border: 1px solid var(--accent); border-radius: var(--radius); box-shadow: 0 8px 32px #0006; color: var(--text); font-size: max(14px, var(--fs)); }
  .annotation-chat.top { top: 8px; bottom: auto; }
  .annotation-chat.sized { max-height: calc(100% - 48px); }
  .sized .messages { flex: 1 1 0; min-height: 3lh; max-height: none; }
  .grip { position: absolute; z-index: 2; left: 0; top: 0; width: 14px; height: 14px; cursor: nwse-resize; touch-action: none; border-left: 1px solid var(--dim); border-top: 1px solid var(--dim); border-top-left-radius: var(--radius); opacity: 0.5; }
  .top .grip { top: auto; bottom: 0; cursor: nesw-resize; border-top: 0; border-bottom: 1px solid var(--dim); border-radius: 0 0 0 var(--radius); }
  .grip:hover { opacity: 1; }
  header { position: sticky; top: 0; z-index: 1; display: flex; gap: 12px; align-items: start; padding-top: 16px; background: var(--panel); }
  header div { flex: 1; display: grid; gap: 4px; }
  header button { font-size: 22px; }
  strong { color: var(--bright); }
  p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
  .prices { color: var(--accent); font-family: var(--mono); font-weight: 600; }
  .messages { display: grid; gap: 8px; max-height: 220px; overflow-y: auto; flex-shrink: 0; }
  .quick button { color: var(--accent); }
  .waiting { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; }
  .waiting small { font-family: var(--mono); }
  .quick { display: flex; flex-wrap: wrap; gap: 2px 12px; }
  .quick button { padding: 2px 0; }
  small, .dim { color: var(--dim); font-size: max(8px, 0.85em); line-height: 1.4; }
  form { display: grid; gap: 8px; }
  textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 64px; max-height: 160px; padding: 10px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); color: var(--text); font: inherit; }
  button { padding: 6px 10px; border-radius: var(--radius); }
  .error { color: var(--sell); }
  .actions { display: flex; justify-content: flex-end; gap: 8px; }
  .delete { color: var(--sell); margin-right: auto; }
  @media (max-width: 900px) {
    textarea { font-size: 16px; min-height: 44px; }
    .grip { display: none; }
    .annotation-chat, .annotation-chat.sized { left: 4px; right: 4px; bottom: 4px; width: auto; height: auto; max-height: calc(100% - 8px); gap: 6px; padding: 0 10px 10px; }
    .annotation-chat.top { top: 4px; }
    header { padding-top: 6px; align-items: center; }
    .messages { max-height: none; }
  }
</style>
