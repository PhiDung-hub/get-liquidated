import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const git = (/** @type {string} */ cmd) => execSync(`git ${cmd}`, { encoding: 'utf8' }).trim();
const release = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const stamp = (/** @type {Date} */ d) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
// The commit's time, not the build's, so a rebuild of the same source is byte-identical (public-repo/README.md). The public
// mirror has no monorepo history, so the export writes the same string to version.txt.
const pinned = new URL('./version.txt', import.meta.url);
// SvelteKit evaluates this file more than once per build (and again in worker threads); keep one value for all of them.
const version = (process.env.TRADE_UI_VERSION ??= (() => {
  if (existsSync(pinned)) return readFileSync(pinned, 'utf8').trim();
  try {
    return `${release} · ${git('rev-parse --short HEAD')}${git('status --porcelain -- .') ? '-dirty' : ''} · ${stamp(new Date(git('log -1 --format=%cI')))}`;
  } catch {
    return `${release} · dev · ${stamp(new Date())}`;
  }
})());

const GETLIQ = process.env.VITE_GETLIQ_PORT ?? '28657';
const HL = ['https://api.hyperliquid.xyz', 'wss://api.hyperliquid.xyz', 'https://api.hyperliquid-testnet.xyz', 'wss://api.hyperliquid-testnet.xyz'];

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ fallback: 'index.html' }),
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
