<script lang="ts">
  import { version } from '$app/environment';

  const REPO = 'https://github.com/PhiDung-hub/get-liquidated';
  const [release, commit = ''] = version.split(' · ');
  const tag = /^[0-9a-f]{7,40}$/.test(commit) ? `v${release}` : '';
  const HOW = `Compare it with the digest of the manifest.json asset on the ${tag || 'matching'} release, or run the verify command from the README.`;
  const SELF = 'A page checking itself is only a convenience: a tampered page could report anything. The independent check is the verify command in the README.';
  const urlPath = (p: string) => (p === 'index.html' ? '/' : p.endsWith('.html') ? `/${p.slice(0, -5)}` : `/${p}`);
  const sha256 = async (data: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (b) => b.toString(16).padStart(2, '0')).join('');

  let files = $state<[string, string][]>([]);
  let hash = $state('');
  let copied = $state(false);
  let busy = $state(false);
  let result = $state('');
  let failures = $state<string[]>([]);

  async function load() {
    const res = await fetch('/manifest.json', { cache: 'no-store' });
    const body = await res.arrayBuffer();
    const manifest = JSON.parse(new TextDecoder().decode(body));
    if (!res.ok || manifest.version !== version) return;
    files = Object.entries(manifest.files);
    hash = await sha256(body);
  }
  $effect(() => { load().catch(() => {}); });

  async function copy() {
    try { await navigator.clipboard.writeText(hash); copied = true; setTimeout(() => (copied = false), 1500); } catch { /* the title still shows the full hash */ }
  }

  async function problem([path, want]: [string, string]) {
    const res = await fetch(urlPath(path), { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) return `${path}: ${res ? `HTTP ${res.status}` : 'not reachable'}`;
    if (res.redirected) return `${path}: redirects to ${new URL(res.url).pathname}`;
    return (await sha256(await res.arrayBuffer())) === want ? '' : `${path}: differs`;
  }

  async function verify() {
    busy = true;
    const found: string[] = [];
    for (let i = 0; i < files.length; i += 8) found.push(...(await Promise.all(files.slice(i, i + 8).map(problem))));
    failures = found.filter(Boolean);
    result = `${files.length - failures.length} of ${files.length} files match`;
    busy = false;
  }
</script>

<span class="proof">
  {#if tag}<a href="{REPO}/releases/tag/{tag}" target="_blank" rel="noopener noreferrer" data-testid="build-version" title="{version}. Opens the public source of this release.">{tag}</a>{:else}<span data-testid="build-version" title={version}>v{release}</span>{/if}
  {#if hash}
    <button class="hash" data-testid="build-hash" title="SHA-256 of /manifest.json, which lists the hash of every file this site serves: {hash}. {HOW} Click to copy." onclick={copy}>{copied ? 'copied to clipboard' : `sha256 ${hash.slice(0, 12)}`}</button>
    <button data-testid="build-verify" disabled={busy} title="Downloads every file in /manifest.json from this site again and compares its SHA-256. {SELF}" onclick={verify}>{busy ? 'Verifying…' : result || 'Verify'}</button>
    {#if failures.length}<span class="bad" data-testid="build-failures" title={failures.join('\n')}>{failures.slice(0, 2).join(' · ')}{failures.length > 2 ? ` · ${failures.length - 2} more` : ''}</span>{/if}
  {/if}
</span>

<style>
  .proof { display: inline-flex; align-items: center; gap: 8px; min-width: 0; white-space: nowrap; }
  a, button { background: none; padding: 0; color: inherit; text-decoration: none; }
  a:hover, button:hover:not(:disabled) { color: var(--bright); }
  .bad { color: var(--warn); overflow: hidden; text-overflow: ellipsis; }
  @media (max-width: 900px) { .hash, .bad { display: none; } }
</style>
