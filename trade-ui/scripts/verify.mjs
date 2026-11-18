#!/usr/bin/env node
// Checks that a deployed Get Liquidated site serves exactly the files of a build (see VERIFY.md).
//   node scripts/verify.mjs manifest [build]             print the build's SHA-256 manifest as JSON (the build writes it to build/manifest.json)
//   node scripts/verify.mjs <site-url> [build|manifest]  compare every file the site serves against it
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
// _headers configures Cloudflare and is never served; manifest.json cannot hold its own hash, so it is compared as a whole instead.
const MANIFEST = 'manifest.json';
const NOT_LISTED = new Set(['_headers', MANIFEST]);
const print = (manifest) => `${JSON.stringify(manifest, null, 1)}\n`;

function manifestOf(dir) {
  const files = Object.fromEntries(walk(dir).map((f) => [relative(dir, f).split(sep).join('/'), f]).filter(([p]) => !NOT_LISTED.has(p)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([p, f]) => [p, sha(readFileSync(f))]));
  return { version: JSON.parse(readFileSync(join(dir, '_app/version.json'), 'utf8')).version, files };
}

/** The manifest and the exact text the site must serve at /manifest.json. */
function load(src) {
  const text = statSync(src).isDirectory() ? print(manifestOf(src)) : readFileSync(src, 'utf8');
  return { ...JSON.parse(text), text };
}
// Cloudflare serves x.html at /x and index.html at /, redirecting the .html spelling.
const urlPath = (p) => (p === 'index.html' ? '/' : p.endsWith('.html') ? `/${p.slice(0, -5)}` : `/${p}`);

// Ask as a browser does: Cloudflare rewrites only responses to an HTML Accept (its analytics beacon), and a plain fetch would miss that.
const BROWSER = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' };
const accept = (p) => (p.endsWith('.html') ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' : '*/*');

async function fetchHash(site, p) {
  const res = await fetch(new URL(urlPath(p), site), { redirect: 'manual', cache: 'no-store', headers: { ...BROWSER, accept: accept(p) } });
  if (res.status !== 200) return { status: res.status };
  return { status: 200, hash: sha(Buffer.from(await res.arrayBuffer())) };
}

async function verify(site, want) {
  const live = await fetchHash(site, '_app/version.json');
  if (live.hash !== want.files['_app/version.json']) {
    const served = await fetch(new URL('/_app/version.json', site), { cache: 'no-store' }).then((r) => r.text(), () => '?');
    console.error(`✗ ${site} serves ${served.trim()}, this build is ${JSON.stringify({ version: want.version })}: check out that release first`);
    return false;
  }
  const paths = Object.keys(want.files);
  const digest = sha(want.text);
  const served = await fetchHash(site, MANIFEST).catch((e) => ({ status: String(e) }));
  const bad = served.hash === digest ? [] : [{ p: MANIFEST, ...served }];
  for (let i = 0; i < paths.length; i += 8) {
    const got = await Promise.all(paths.slice(i, i + 8).map(async (p) => ({ p, ...(await fetchHash(site, p).catch((e) => ({ status: String(e) }))) })));
    for (const g of got) if (g.hash !== want.files[g.p]) bad.push(g);
  }
  for (const b of bad) console.error(`✗ ${b.p}: ${b.hash ? `sha256 ${b.hash} ≠ ${want.files[b.p] ?? digest}` : `HTTP ${b.status}`}`);
  console.log(bad.length ? `✗ ${bad.length} of ${paths.length} files differ from ${want.version}` : `✓ ${site} serves ${want.version}: all ${paths.length} files match byte for byte, manifest.json sha256 ${digest}`);
  return !bad.length;
}

const [cmd, src = 'build'] = process.argv.slice(2);
if (cmd === 'manifest') process.stdout.write(print(manifestOf(src)));
else if (/^https?:\/\//.test(cmd ?? '')) process.exitCode = (await verify(cmd, load(src))) ? 0 : 1;
else (console.error('usage: node scripts/verify.mjs manifest [build] | <site-url> [build|manifest.json]'), (process.exitCode = 2));
