import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const git = (/** @type {string} */ cmd) => execSync(`git ${cmd}`, { encoding: 'utf8', cwd: new URL('.', import.meta.url) }).trim();
const release = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const stamp = (/** @type {Date} */ d) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
// The last commit to touch what the bundle is built from, not HEAD or the clock: a rebuild of the same source is
// byte-identical, and docs, tests or CI commits leave a deployed build verifiable (public-repo/README.md). The public
// mirror has no monorepo history, so the export writes the same string to version.txt.
const INPUTS = 'src static svelte.config.js vite.config.ts tsconfig.json package.json ../agent/src/wire.ts ../pnpm-lock.yaml';
const pinned = new URL('./version.txt', import.meta.url);
// SvelteKit evaluates this file more than once per build (and again in worker threads); keep one value for all of them.
const version = (process.env.TRADE_UI_VERSION ??= (() => {
  if (existsSync(pinned)) return readFileSync(pinned, 'utf8').trim();
  try {
    const [sha, at] = git(`log -1 --format='%h %cI' -- ${INPUTS}`).split(' ');
    return `${release} · ${sha}${git(`status --porcelain -- ${INPUTS}`) ? '-dirty' : ''} · ${stamp(new Date(at))}`;
  } catch {
    return `${release} · dev · ${stamp(new Date())}`;
  }
})());

const staticAdapter = adapter();
const stableStatic = {
  ...staticAdapter,
  /** @param {import('@sveltejs/kit').Builder} builder */
  async adapt(builder) {
    await staticAdapter.adapt(builder);
    const path = new URL('./build/index.html', import.meta.url);
    const html = readFileSync(path, 'utf8');
    // The chunk traversal order can differ between builds. Keep the entry and route links in place.
    const chunks = /<link href="\/_app\/immutable\/chunks\/[^"]+" rel="modulepreload">/g;
    const ordered = (html.match(chunks) ?? []).sort();
    let index = 0;
    writeFileSync(path, html.replace(chunks, () => ordered[index++]));
  }
};

const GETLIQ = process.env.VITE_GETLIQ_PORT ?? '28657';
const HL = ['https://api.hyperliquid.xyz', 'wss://api.hyperliquid.xyz', 'https://api.hyperliquid-testnet.xyz', 'wss://api.hyperliquid-testnet.xyz'];

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: stableStatic,
    paths: { relative: false },
    inlineStyleThreshold: 140_000,
    version: { name: version },
    csp: {
      mode: 'hash',
      directives: {
        'default-src': ['self'],
        'script-src': ['self'],
        'style-src': ['self', 'unsafe-inline'],
        'connect-src': ['self', ...HL, `http://127.0.0.1:${GETLIQ}`, `ws://127.0.0.1:${GETLIQ}`],
        'img-src': ['self', 'data:'],
        'object-src': ['none'],
        'base-uri': ['self'],
        'form-action': ['none']
      }
    }
  }
};
