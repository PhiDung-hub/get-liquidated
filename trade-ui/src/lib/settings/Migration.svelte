<script lang="ts">
  import { onMount } from 'svelte';
  import { AGENT_MIGRATION_PROMPT, applyMigration, EXTRACTION_SCRIPT, MIGRATION_LIMIT, previewMigration, type MigrationPreview } from './migration';
  import { exportJson, importJson } from './settings.svelte';
  import { ui } from '$lib/ui/state.svelte';
  import { ticket } from '$lib/orders/ticket.svelte';
  import { settings } from './settings.svelte';

  const BACKUP_KEY = 'trade-ui:migration-backup';
  let text = $state('');
  let selected = $state<string[]>([]);
  let message = $state('');
  let backup = $state(false);
  let promptOpen = $state(false);
  let copyButton: HTMLButtonElement;
  const result = $derived.by((): { preview: MigrationPreview | null; error: string } => {
    if (!text.trim()) return { preview: null, error: '' };
    try { return { preview: previewMigration(text), error: '' }; }
    catch (error) { return { preview: null, error: (error as Error).message }; }
  });
  $effect(() => { result; selected = []; });
  onMount(() => {
    try { backup = localStorage.getItem(BACKUP_KEY) !== null; }
    catch { message = 'Browser storage unavailable. Import needs a saved backup.'; }
    copyButton?.focus();
  });
  async function copyAgentPrompt() {
    try {
      await navigator.clipboard.writeText(AGENT_MIGRATION_PROMPT);
      message = 'Agent prompt copied. Paste it into Claude Code or Codex.';
    } catch {
      promptOpen = true;
      message = 'Clipboard unavailable. Copy the expanded prompt below.';
    }
  }
  function backUp() {
    const json = exportJson();
    try { localStorage.setItem(BACKUP_KEY, json); }
    catch { throw new Error('Could not save backup. Free browser storage before importing.'); }
    if (localStorage.getItem(BACKUP_KEY) !== json) throw new Error('Could not save backup. Import cancelled.');
    backup = true;
  }
  function saveBackup() {
    try { backUp(); message = 'Current settings backed up in this browser.'; }
    catch { message = 'Could not save backup. Free browser storage before importing.'; }
  }
  function restore() {
    try {
      const json = localStorage.getItem(BACKUP_KEY);
      if (!json) throw new Error('No backup found in this browser.');
      const warnings = importJson(json);
      ticket.kind = settings.panel.kind;
      if (ticket.unit !== settings.panel.sizeUnit) ticket.size = 0;
      ticket.unit = settings.panel.sizeUnit;
      message = warnings.length ? warnings.join('; ') : 'Backup restored';
      selected = [];
    } catch (error) { message = (error as Error).message; }
  }
  function apply() {
    if (!result.preview || !selected.length) return;
    try {
      backUp();
      const warnings = applyMigration(text, selected, result.preview);
      const order = result.preview.fields.find(f => f.id === 'order' && selected.includes(f.id))?.patch.panel as { kind?: string; sizeUnit?: string } | undefined;
      if (order?.kind) ticket.kind = settings.panel.kind;
      if (order?.sizeUnit) {
        if (ticket.unit !== settings.panel.sizeUnit) ticket.size = 0;
        ticket.unit = settings.panel.sizeUnit;
      }
      message = warnings.length ? warnings.join('; ') : 'Selected preferences imported';
      selected = [];
      text = '';
    } catch (error) { message = (error as Error).message; }
  }
</script>

<div class="scrim" role="presentation" onclick={() => (ui.overlay = null)}></div>
<div class="migration" role="dialog" aria-modal="true" aria-labelledby="migration-title" data-testid="migration">
  <header>
    <div><span class="eyebrow">BRING YOUR SETUP</span><h3 id="migration-title">Move from Hyperliquid</h3></div>
    <button class="x" aria-label="Close migration" onclick={() => (ui.overlay = null)}>✕</button>
  </header>
  <p class="intro">Your markets. Your chart. A familiar start.</p>
  <section class="ask">
    <div class="step"><span class="number">1</span><h4>Ask your AI</h4><span class="tag">Recommended</span></div>
    <p>Paste this prompt into Claude Code or Codex with the local getliq companion. Your AI walks you through the move and stops for your review.</p>
    <button class="primary" bind:this={copyButton} onclick={copyAgentPrompt}>Copy local AI agent prompt <span aria-hidden="true">↗</span></button>
    <details bind:open={promptOpen}>
      <summary>Read or copy the prompt</summary>
      <textarea aria-label="Local AI agent migration prompt" readonly rows="7" value={AGENT_MIGRATION_PROMPT}></textarea>
    </details>
  </section>
  <section>
    <div class="step"><span class="number">2</span><h4>Paste & review</h4></div>
    <p>Only checked groups will change. Everything stays local.</p>
    <textarea aria-label="Hyperliquid migration JSON" rows="4" maxlength={MIGRATION_LIMIT} bind:value={text} oninput={() => { selected = []; message = ''; }} placeholder="Paste your preference export here…" spellcheck="false"></textarea>
    {#if result.error}<p class="warning" role="alert">{result.error}</p>{/if}
    {#if result.preview}
      <div class="preview" aria-label="Migration preview">
        {#each result.preview.warnings as warning}<p class="warning">{warning}</p>{/each}
        {#each result.preview.fields as field (field.id)}
          <label><input type="checkbox" bind:group={selected} value={field.id} /><span><strong>{field.label}</strong><span class="detail">{field.detail}</span></span></label>
        {/each}
        {#if !result.preview.fields.length}<p>No supported preferences found.</p>{/if}
      </div>
    {/if}
    <div class="actions"><button class="primary" disabled={!result.preview || !selected.length} onclick={apply}>Import selected preferences</button><span>{selected.length ? `${selected.length} selected` : 'Nothing selected'}</span></div>
    <p class="fine">A backup is saved before every import. Review slippage and order defaults before trading.</p>
  </section>
  <div class="backup"><button onclick={saveBackup}>Back up current settings</button><button disabled={!backup} onclick={restore}>Restore backup</button></div>
  <details class="manual">
    <summary>Manual export or JSON</summary>
    <p>On app.hyperliquid.xyz, review and run this script in the developer console. Copy its returned JSON here. It reads four named preference keys only, writes nothing and makes no requests. Never paste a full storage dump. If console paste is blocked, use the JSON example; keep browser protections on.</p>
    <textarea aria-label="Hyperliquid extraction script" readonly rows="7" value={EXTRACTION_SCRIPT}></textarea>
    <p>Read visible settings to fill this example with your own values. Omit unavailable groups. Studies, book grouping and order defaults need visible UI transcription; their storage formats are not verified. The AI prompt includes the full schema and study input names.</p>
    <pre>{'{"format":"hyperliquid-preferences","version":1,"preferences":{"favorite-coins":["BTC","xyz:NVDA","HYPE/USDC"],"hyperliquid.max_slippage":0.01,"chart":{"interval":"15","style":1,"timezone":"UTC"},"studies":[{"name":"RSI","inputs":{"length":14},"visible":true}],"order":{"kind":"limit","sizeUnit":"usd"}}}'}</pre>
    <p>Symbols resolve against this app’s market metadata. Unresolved markets and studies without an equivalent are listed and skipped. No wallet, account, keys or sessions are transferred.</p>
  </details>
  <p class="status" role="status">{message}</p>
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 20; background: #000b; }
  .migration { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 21; width: min(620px, calc(100vw - 32px)); max-height: 90dvh; overflow-y: auto; padding: 24px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); box-shadow: 0 24px 80px #0007; }
  header, .step, .actions, .backup { display: flex; align-items: center; gap: 10px; }
  header { justify-content: space-between; }
  .eyebrow { color: var(--dim); font-size: 10px; letter-spacing: 0.14em; }
  h3 { margin: 6px 0 0; color: var(--bright); font-size: 24px; letter-spacing: -0.03em; }
  h4 { margin: 0; color: var(--bright); font-size: 16px; }
  p { color: var(--dim); margin: 10px 0; line-height: 1.5; }
  .intro { margin: 8px 0 20px; font-size: 14px; }
  .x { background: none; color: var(--dim); padding: 8px; align-self: flex-start; }
  section { padding: 16px; border: 1px solid var(--line); border-radius: var(--radius); margin-top: 12px; }
  .ask { background: var(--surface); }
  .number { display: grid; place-items: center; width: 24px; height: 24px; border: 1px solid var(--line); border-radius: var(--radius); color: var(--bright); font-family: var(--mono); }
  .tag { margin-left: auto; color: var(--dim); font-size: 10px; }
  .primary { background: var(--accent); color: var(--bg); padding: 10px 14px; font-weight: 600; }
  .ask > .primary { display: flex; justify-content: space-between; gap: 20px; width: 100%; }
  details { margin-top: 10px; }
  summary { color: var(--dim); cursor: pointer; padding: 6px 0; }
  textarea { display: block; width: 100%; resize: vertical; font: 12px/1.5 var(--mono); margin: 10px 0; border: 1px solid var(--line); background: var(--bg); }
  .preview label { display: flex; align-items: flex-start; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line); }
  input { flex-shrink: 0; margin-top: 3px; }
  strong { color: var(--bright); font-weight: 500; }
  .detail { display: block; color: var(--dim); margin-top: 4px; line-height: 1.5; overflow-wrap: anywhere; }
  .warning { color: var(--warn); overflow-wrap: anywhere; }
  .actions { margin-top: 12px; }
  .actions > span, .fine { font-size: 11px; color: var(--dim); }
  .fine { margin-bottom: 0; }
  .backup { margin-top: 14px; flex-wrap: wrap; }
  .backup button { background: none; color: var(--dim); border: 1px solid var(--line); padding: 6px 10px; }
  .manual { border-top: 1px solid var(--line); padding-top: 8px; margin-top: 16px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dim); font: 11px/1.5 var(--mono); }
  .status { color: var(--bright); margin-bottom: 0; }
  .status:empty { display: none; }
  @media (max-width: 900px) {
    .migration { inset: auto 0 0; transform: none; width: 100%; max-height: 94dvh; padding: 20px 16px calc(20px + env(safe-area-inset-bottom)); border-radius: var(--radius) var(--radius) 0 0; border-width: 1px 0 0; }
    h3 { font-size: 23px; }
    section { padding: 14px; }
    textarea { font-size: 16px; }
    summary, .preview label, button { min-height: 36px; }
    .actions { align-items: flex-start; flex-direction: column; gap: 6px; }
    .actions > button { width: 100%; }
  }
</style>
