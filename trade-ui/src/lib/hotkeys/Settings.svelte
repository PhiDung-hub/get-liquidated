<script lang="ts">
  import { onDestroy } from 'svelte';
  import { ACTIONS, GROUPS, SIDE, bindingsFor, checkCapture, dropShadowed, keyLabel, sameKey, type ActionId, type Group } from './keymap';
  import Sided from '$lib/ui/Sided.svelte';
  import { settings, persist, exportJson, importJson, resetSettings, DEFAULTS, RANGES, type Binding, type HotkeyType, type SizeUnit } from '$lib/settings/settings.svelte';
  import { THEMES } from '$lib/settings/themes';
  import { market } from '$lib/market/market.svelte';
  import { symOf } from '$lib/market/meta.svelte';
  import { ui, type SettingsTab } from '$lib/ui/state.svelte';
  import { session } from '$lib/session/session.svelte';
  import Integrations from '$lib/ui/Integrations.svelte';
  import { tabNavigation } from '$lib/ui/touch';

  const bound = (path: string, k = 1) => { const [lo, hi] = RANGES[path]; return { min: lo * k, max: hi === Infinity ? undefined : hi * k }; };
  const TABS: { id: SettingsTab; label: string }[] = [
    { id: 'execution', label: 'Execution' }, { id: 'hotkeys', label: 'Hotkeys' }, { id: 'display', label: 'Display' }, { id: 'data', label: 'Data' }
  ];

  let hotkeyGroup = $state<Group>('Navigation');
  let capturing = $state<ActionId | null>(null);
  let msg = $state('');
  let json = $state('');

  function selectGroup(group: Group) {
    if (capturing) {
      stopCapture();
      msg = 'rebind cancelled';
    }
    hotkeyGroup = group;
  }

  function groupKey(e: KeyboardEvent) {
    const index = GROUPS.indexOf(hotkeyGroup);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? GROUPS.length - 1 : e.key === 'ArrowRight' ? (index + 1) % GROUPS.length : e.key === 'ArrowLeft' ? (index + GROUPS.length - 1) % GROUPS.length : -1;
    if (next < 0) return;
    e.preventDefault();
    selectGroup(GROUPS[next]);
    document.getElementById(`hotkey-group-${hotkeyGroup}`)?.focus();
  }

  function stopCapture() {
    window.removeEventListener('keydown', onCapture, true);
    window.removeEventListener('pointerdown', onPointer, true);
    capturing = null;
  }

  function onPointer() {
    stopCapture();
    msg = 'rebind cancelled';
  }

  function onCapture(e: KeyboardEvent) {
    if (!capturing || e.repeat) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const id = capturing;
    if (e.code === 'Escape' && !e.shiftKey) return void (stopCapture(), (msg = 'rebind cancelled'));
    const result = checkCapture(e);
    if (!('binding' in result) && /^(Shift|Control|Alt|Meta)/.test(e.code)) return;
    stopCapture();
    if ('error' in result) return void (msg = result.error);
    const fixed = ACTIONS.find((a) => a.fixed && bindingsFor(a.id).some((b) => sameKey(b, result.binding)));
    if (fixed) return void (msg = `${keyLabel(result.binding)} is fixed to ${fixed.label}`);
    const taken = takeFromOthers(id, [result.binding]);
    settings.bindings[id] = [result.binding];
    persist();
    msg = [result.warning, moved(taken)].filter(Boolean).join(' · ') || `bound ${keyLabel(result.binding)}`;
  }

  /** One key drives one action: unbind `keys` from every other action and return those actions. */
  function takeFromOthers(id: ActionId, keys: Binding[]) {
    const hit = (b: Binding) => keys.some((k) => sameKey(b, k));
    const taken = ACTIONS.filter((a) => a.id !== id && !a.fixed && bindingsFor(a.id).some(hit));
    for (const a of taken) settings.bindings[a.id] = bindingsFor(a.id).filter((b) => !hit(b));
    return taken;
  }

  const moved = (taken: { label: string }[]) => (taken.length ? `moved from ${taken.map((a) => a.label).join(', ')}` : '');

  function startCapture(id: ActionId) {
    msg = 'press the new key (Esc cancels)';
    capturing = id;
    window.addEventListener('keydown', onCapture, true);
    // Any click elsewhere (a tab, Reset all, a field) ends the capture, or the next key typed there would rebind silently.
    window.addEventListener('pointerdown', onPointer, true);
  }

  function resetBinding(id: ActionId) {
    delete settings.bindings[id];
    msg = moved(takeFromOthers(id, bindingsFor(id))) || 'default restored';
    persist();
  }

  function onEdit(e: Event) {
    const bad = persist();
    const el = e.target as HTMLElement;
    const field = el.closest('label')?.firstChild?.textContent?.trim() || el.getAttribute('aria-label');
    const group = el.closest('section')?.querySelector('h4')?.textContent?.replace(/ \(.*\)$/, '');
    const name = field ? [group, field].filter(Boolean).join(' · ') : bad.join(', ');
    msg = bad.length ? `invalid ${name} — kept the previous value` : '';
  }

  function doImport() {
    try {
      const warnings = importJson(json);
      const dropped = dropShadowed();
      persist();
      if (dropped.length) warnings.push(`unbound ${dropped.join(', ')}: key already taken`);
      msg = warnings.length ? `imported with warnings: ${warnings.join('; ')}` : 'imported';
    } catch {
      msg = 'invalid JSON — nothing changed';
    }
  }

  function doExport() {
    json = exportJson();
    void navigator.clipboard?.writeText(json).then(() => (msg = 'exported and copied'), () => (msg = 'exported'));
  }

  const HOTKEY_ROWS: { t: HotkeyType; label: string; ids: [ActionId, ActionId] }[] = [
    { t: 'market', label: 'Market', ids: ['buyMkt', 'sellMkt'] },
    { t: 'alo', label: 'ALO at best', ids: ['bidAlo', 'askAlo'] },
    { t: 'chase', label: 'Chase', ids: ['chaseBuy', 'chaseSell'] },
    { t: 'scale', label: 'Scale total', ids: ['scaleBuy', 'scaleSell'] }
  ];
  /** "Shift+B / S": the sell key drops the modifier it shares with the buy key. */
  function keyPair(ids: [ActionId, ActionId]) {
    const [buy, sell] = ids.map((id) => bindingsFor(id).map(keyLabel)[0] ?? '—');
    const mod = buy.match(/^(.*\+)./)?.[1] ?? '';
    return [buy, mod && sell.startsWith(mod) ? sell.slice(mod.length) : sell];
  }
  const keysOf = (id: ActionId) => (bindingsFor(id).map(keyLabel).join(' / ') || '—') + (ACTIONS.find((a) => a.id === id)?.double ? ' twice' : '');
  const modeOf = (t: HotkeyType) => {
    const s = settings.hotkeySizes[t];
    return s.unit === 'pct' ? `pct-${s.basis}` : s.unit === 'coin' ? `coin:${s.coin}` : s.unit;
  };
  /** The coins a row's unit select offers: the selected market, and the coin its size was set for when that differs. */
  const coinsOf = (t: HotkeyType) => [...new Set([market.coin, ...(settings.hotkeySizes[t].coin ? [settings.hotkeySizes[t].coin!] : [])])];
  /** The value each row last had in each unit on each account, so arrowing through the unit select and back restores it. */
  const seen: Record<string, number> = {};
  function setMode(t: HotkeyType, m: string) {
    seen[`${session.master}|${t}|${modeOf(t)}`] = settings.hotkeySizes[t].value;
    const coin = m.startsWith('coin:') ? m.slice(5) : undefined;
    const [unit, basis = 'balance'] = (coin ? ['coin'] : m.split('-')) as [SizeUnit, 'balance' | 'position'];
    settings.hotkeySizes[t] = { value: seen[`${session.master}|${t}|${m}`] ?? 0, unit, basis, ...(coin && { coin }) };
  }

  const pct = (v: number) => Number((v * 100).toFixed(4));
  /** Reset all wipes favourites, layout, bindings and every account's sizes, so it takes a second press. */
  let resetting = $state(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  function reset() {
    clearTimeout(resetTimer);
    if (!resetting) return void ((resetting = true), (resetTimer = setTimeout(() => (resetting = false), 3000)));
    resetting = false;
    resetSettings();
    msg = 'defaults restored';
  }
  onDestroy(() => (clearTimeout(resetTimer), stopCapture(), persist()));
</script>

<div class="scrim" role="presentation" onclick={() => (ui.overlay = null)}></div>
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<div class="settings" role="dialog" tabindex="-1" aria-label="Settings" data-testid="settings" onclick={(e) => e.detail && e.target instanceof HTMLButtonElement && e.target.blur()}>
  <header>
    <h3>Settings</h3>
    {#if ui.settingsTab !== 'data'}<button class:sure={resetting} data-testid="settings-reset" onclick={reset}>{resetting ? 'Reset all?' : 'Reset all'}</button>{/if}
    <span class="msg" data-testid="settings-msg">{ui.settingsTab === 'data' ? '' : msg}</span>
    <button onclick={() => (ui.overlay = null)}>Close</button>
  </header>
  <div class="tabs" role="tablist" aria-label="Settings sections" tabindex="-1" onkeydown={tabNavigation}>
    {#each TABS as t (t.id)}
      <button class="ui-tab" role="tab" aria-selected={ui.settingsTab === t.id} tabindex={ui.settingsTab === t.id ? 0 : -1} class:on={ui.settingsTab === t.id} data-testid="settings-tab-{t.id}" onclick={() => (ui.settingsTab = t.id)}>{t.label}</button>
    {/each}
  </div>
  {#if ui.settingsTab === 'execution' || ui.settingsTab === 'hotkeys'}<button class="migration-link" data-testid="settings-migration" onclick={() => (ui.overlay = 'migration')}>Move from Hyperliquid</button>{/if}

  {#if ui.settingsTab === 'data'}
    <Integrations />
  {:else if ui.settingsTab === 'execution'}
    <div class="cols exec" onchange={onEdit}>
      <div>
        <section class="hks" data-testid="hotkey-sizes">
          <h4>Size per action</h4>
          {#each HOTKEY_ROWS as r (r.t)}
            {@const [buy, sell] = keyPair(r.ids)}
            <div class="hk" data-testid="hotkey-size-{r.t}">
              <span class="keys"><span class="buy">{buy}</span> / <span class="sell">{sell}</span></span>
              <span>{r.label}</span>
              <input type="number" {...bound(`hotkeySizes.${r.t}.value`)} step="any" aria-label="{r.label} size" bind:value={settings.hotkeySizes[r.t].value} />
              <select aria-label="{r.label} size unit" value={modeOf(r.t)} onchange={(e) => setMode(r.t, e.currentTarget.value)}>
                <option value="usd">USD</option>
                {#each coinsOf(r.t) as c (c)}<option value="coin:{c}">{symOf(c)}</option>{/each}
                <option value="pct-balance">% balance</option>
                <option value="pct-position">% position</option>
              </select>
            </div>
          {/each}
          <div class="hk">
            <span class="keys">{keyPair(['sizeDown', 'sizeUp']).join(' / ')}</span>
            <span>Panel step</span>
            <input type="number" {...bound('sizeStep', 100)} aria-label="Panel size step %" bind:value={() => pct(settings.sizeStep), (v) => (settings.sizeStep = v / 100)} />
            <span class="dim">%</span>
          </div>
        </section>
      </div>
      <div>
        <section>
          <h4>Market</h4>
          <label>Slippage <span class="u"><input type="number" {...bound('market.slippage', 100)} step="0.05" bind:value={() => pct(settings.market.slippage), (v) => (settings.market.slippage = v / 100)} /><i>%</i></span></label>
        </section>
        <section>
          <h4>Scale</h4>
          <label>Orders <input type="number" {...bound('scale.count')} bind:value={settings.scale.count} /></label>
          <label>Skew (last/first) <input type="number" {...bound('scale.skew')} step="0.1" bind:value={settings.scale.skew} /></label>
          <label>Range <span class="u"><input type="number" {...bound('scale.rangePct')} step="0.1" bind:value={settings.scale.rangePct} /><i>%</i></span></label>
          <label>Offset <span class="u"><input type="number" {...bound('scale.offsetPct')} step="0.05" bind:value={settings.scale.offsetPct} /><i>%</i></span></label>
          <label>Shape <select bind:value={settings.scale.shape}><option value="linear">linear</option><option value="exp">exponential</option></select></label>
        </section>
        <section>
          <h4>TP/SL</h4>
          {#each [['positionTp', 'Take profit'], ['positionSl', 'Stop loss']] as [id, label] (id)}
            <div class="keyrow" data-testid="exec-key-{id}"><span class="keys">{keysOf(id as ActionId)}</span><span>{label} · full position, price you type</span></div>
          {/each}
          <label>Worst-fill slippage <span class="u"><input type="number" {...bound('tpsl.slippage', 100)} step="0.5" bind:value={() => pct(settings.tpsl.slippage), (v) => (settings.tpsl.slippage = v / 100)} /><i>%</i></span></label>
        </section>
      </div>
      <div>
        <section>
          <h4>Chase</h4>
          <label>Cap <span class="u"><input type="number" {...bound('chase.capPct')} step="0.05" bind:value={settings.chase.capPct} /><i>%</i></span></label>
          <label>Timeout <span class="u"><input type="number" {...bound('chase.timeoutSec')} placeholder="0 = none" title="0 = no timeout" bind:value={settings.chase.timeoutSec} /><i>s</i></span></label>
          <label>On stop <select bind:value={settings.chase.onStop}><option value="rest">leave resting</option><option value="market">market the rest</option></select></label>
          <label>Min gap between modifies <span class="u"><input type="number" {...bound('chase.throttleMs')} step="100" bind:value={settings.chase.throttleMs} /><i>ms</i></span></label>
        </section>
        <section>
          <h4>Close (Shift+C)</h4>
          <label>Mode <select bind:value={settings.closeMode}><option value="limit">limit at best</option><option value="chase">chase</option></select></label>
        </section>
        <section>
          <h4>Cancel</h4>
          {#each [['cancelMarket', 'This market (keeps TP/SL)'], ['cancelLast', 'Last placement here'], ['cancelAll', 'All orders, every market']] as [id, label] (id)}
            <div class="keyrow" data-testid="exec-key-{id}"><span class="keys">{keysOf(id as ActionId)}</span><span>{label}</span></div>
          {/each}
        </section>
      </div>
    </div>
  {:else if ui.settingsTab === 'hotkeys'}
    <div class="tabs hotkey-tabs" role="tablist" aria-label="Hotkey groups">
      {#each GROUPS as group}
        <button class="ui-tab" id="hotkey-group-{group}" role="tab" aria-selected={hotkeyGroup === group} aria-controls="hotkey-group-panel" tabindex={hotkeyGroup === group ? 0 : -1} class:on={hotkeyGroup === group} data-testid="hotkey-group-{group}" onclick={() => selectGroup(group)} onkeydown={groupKey}>{group}</button>
      {/each}
    </div>
    <div class="hotkey-group" id="hotkey-group-panel" role="tabpanel" aria-labelledby="hotkey-group-{hotkeyGroup}" tabindex="0">
      <h4>{hotkeyGroup}</h4>
      {#each ACTIONS.filter((a) => a.group === hotkeyGroup) as a (a.id)}
        <div class="row">
          <span><Sided text={a.label} side={SIDE[a.id]} />{a.double ? ' (2×)' : ''}</span>
          <span class="keys {SIDE[a.id] ?? ''}" data-testid="bind-{a.id}">{bindingsFor(a.id).map(keyLabel).join(' / ') || '—'}</span>
          {#if !a.fixed}
            <button class:on={capturing === a.id} data-testid="rebind-{a.id}" onclick={(e) => (e.currentTarget.blur(), startCapture(a.id))}>{capturing === a.id ? '…' : 'Rebind'}</button>
            <button class="dim" title="restore default" disabled={!settings.bindings[a.id]} onclick={() => resetBinding(a.id)}>↺</button>
          {/if}
        </div>
      {/each}
    </div>
    <div class="cols" onchange={onEdit}>
      <section>
        <h4>Arming</h4>
        <label>Disarm after idle min <input type="number" {...bound('idleMin')} bind:value={settings.idleMin} /></label>
      </section>
    </div>
    <section class="io">
      <h4>Import / export</h4>
      <textarea rows="5" data-testid="settings-json" bind:value={json} placeholder="Paste settings JSON to import"></textarea>
      <div>
        <button data-testid="settings-export" onclick={doExport}>Export</button>
        <button data-testid="settings-import" onclick={doImport}>Import</button>
      </div>
    </section>
  {:else}
    <div class="display-grid" onchange={onEdit} data-testid="display-settings">
      <section class="appearance" aria-labelledby="display-appearance">
        <h4 id="display-appearance">Appearance</h4>
        <label class="theme-field">Theme
          <select aria-label="Theme" bind:value={settings.display.theme}>
            {#each THEMES as t}<option value={t.id}>{t.name}{t.id === DEFAULTS.display.theme ? ' (default)' : ''}</option>{/each}
          </select>
        </label>
        <label>Text size (px) <input type="number" {...bound('display.fs')} step="1" bind:value={settings.display.fs} /></label>
        <label title="Sounds, close and liquidation animations, the big-win popup and Pepe on liquidated fills, all together">LOL mode <input type="checkbox" data-testid="settings-lol" bind:checked={settings.display.lol} /></label>
      </section>
      <section class="display-options" aria-labelledby="display-chart">
        <h4 id="display-chart">Chart & markets</h4>
        <label>Show buy/sell markers <input type="checkbox" bind:checked={settings.chart.indicators.fills.on} /></label>
        <label title="Previous and next favourite shortcuts cycle only through the markets in the pinned section">Cycle pinned markets only <input type="checkbox" data-testid="settings-superstar" bind:checked={settings.display.superstar} /></label>
      </section>
    </div>
    <footer class="display-footer">
      <span class="dim">Changes save automatically</span>
      <button data-testid="settings-migration" onclick={() => (ui.overlay = 'migration')}>Move from Hyperliquid</button>
    </footer>
  {/if}
</div>

<style>
  .scrim { position: fixed; inset: 0; background: #000c; z-index: 20; }
  .settings { position: fixed; inset: 4vh 50% auto auto; transform: translateX(50%); width: min(1000px, calc(100vw - 32px)); max-height: 92vh; overflow: auto; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px; z-index: 21; font-size: var(--fs); }
  header { display: flex; gap: 8px; align-items: center; }
  h3 { margin: 0 12px 0 0; }
  h4 { margin: 0 0 6px; color: var(--bright); font-weight: 600; }
  header .sure { color: var(--sell-text); font-weight: 600; }
  .msg { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--warn); }
  .migration-link { margin-top: 10px; }
  .tabs { display: flex; gap: 4px; margin-top: 10px; border-bottom: 1px solid var(--line); }
  .tabs button { padding: 7px 12px; }
  .hotkey-tabs { flex-wrap: wrap; }
  .hotkey-tabs button { flex: none; }
  .hotkey-group { margin-top: 12px; padding: 10px 12px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); }
  .hotkey-group .row { grid-template-columns: minmax(0, 1fr) minmax(70px, auto) auto auto; }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-top: 12px; align-items: start; }
  .cols > div { display: flex; flex-direction: column; gap: 12px; }
  .display-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 14px; align-items: start; }
  .display-grid section { min-width: 0; padding: 14px 16px; }
  .display-grid h4 { margin-bottom: 8px; }
  .appearance label { grid-template-columns: minmax(0, 1fr) auto; min-height: 40px; }
  .appearance select { width: 180px; }
  .appearance input { width: 80px; justify-self: end; }
  .display-options label { grid-template-columns: minmax(0, 1fr) 20px; gap: 16px; min-height: 40px; padding: 8px 0; }
  .display-options label + label { border-top: 1px solid var(--line); }
  .display-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }

  .exec { grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1fr); }
  section { padding: 10px 12px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); }
  .row { display: grid; grid-template-columns: 1fr 70px auto auto; gap: 6px; align-items: center; padding: 1px 0; }
  .keys { font-family: var(--mono); color: var(--accent); }
  .keys.buy { color: var(--buy-text); }
  .keys.sell { color: var(--sell-text); }
  .row button { padding: 1px 6px; }
  .row button.on { background: var(--warn); color: var(--bg); }
  label { display: grid; grid-template-columns: minmax(0, 1fr) 120px; gap: 8px; align-items: center; padding: 2px 0; color: var(--dim); }
  label > input, label > select, label > .u { width: 100%; }
  label > input[type='checkbox'] { width: auto; justify-self: end; }
  .u { position: relative; display: flex; }
  .u input { width: 100%; padding-right: 2.4em; }
  .u i { position: absolute; right: 7px; top: 50%; transform: translateY(-50%); color: var(--faint); font-style: normal; pointer-events: none; }
  .dim { color: var(--dim); }
  .hks { display: grid; grid-template-columns: auto auto minmax(0, 1fr) minmax(0, 1fr); gap: 5px 8px; align-items: center; color: var(--dim); }
  .hks .keys { justify-self: start; padding: 1px 6px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); font-size: max(8px, 0.9em); }
  .hks h4 { grid-column: 1 / -1; }
  .hk { display: contents; }
  .keyrow { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; }
  .keyrow .keys { flex: none; padding: 1px 6px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); font-size: max(8px, 0.9em); }
  .hk input, .hk select { min-width: 0; }
  .hk > span { white-space: nowrap; }
  .io { margin-top: 12px; }
  .io textarea { display: block; width: 100%; box-sizing: border-box; padding: 8px; resize: vertical; font: max(8px, calc(var(--fs) * 0.917))/1.5 var(--mono); }
  @media (max-width: 600px) {
    .display-grid { grid-template-columns: minmax(0, 1fr); }
    .appearance .theme-field { grid-template-columns: minmax(0, 1fr); gap: 4px; }
    .appearance select { width: 100%; }
    .display-footer { align-items: stretch; flex-direction: column; }
  }
  @media (max-width: 900px) {
    .exec { grid-template-columns: 1fr; }
    label { min-height: 36px; }
    .io textarea { font-size: max(16px, 1em); }
    .hks .keys { display: none; }
    .hks { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(72px, auto); }
    [data-testid='settings'] { inset: auto 0 0; transform: none; width: 100%; height: 92vh; border-width: 1px 0 0; padding-bottom: calc(14px + env(safe-area-inset-bottom)); }
  }
</style>
