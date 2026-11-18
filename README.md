# Get Liquidated

The source of the trade screen served at **https://get.hyperliqui.date**: a static Svelte 5 app that talks to Hyperliquid straight from your browser.

You never paste a key into it. **Enable trading** creates a Hyperliquid agent (API) key inside your browser, your wallet approves it with an expiry, and it stays in this site's local storage. Orders leave signed for `api.hyperliquid.xyz`; the key itself never does. Withdrawals and transfers need your own wallet's signature, which an agent key cannot give. **Link phone** makes a separate key for the phone, encrypts it with your PIN (PBKDF2, AES-GCM) and carries it in the link's `#` fragment, which browsers never send to a server.

Don't take that on trust: every claim is in this code, and the steps below prove the site runs exactly this code.

## Check the live site is this code

Each release is the same commit of the private monorepo, exported here and tagged `vX.Y.Z`. Building it twice gives the same bytes, and the build stamps the commit, not the clock, into `_app/version.json`. (The short commit id in the version string is the private monorepo's, so it does not exist here; the tag is what to check out.)

The build also writes `manifest.json`: the SHA-256 of every file the site serves, except `manifest.json` itself, since a file cannot contain its own hash. The site serves it at [`/manifest.json`](https://get.hyperliqui.date/manifest.json), and CI attaches the very same bytes to the GitHub release. So one hash, the SHA-256 of `manifest.json`, names a whole build.

**In the page.** At the bottom right, the version is a link to its release here. Next to it is `sha256` and the first 12 characters of the SHA-256 of the `/manifest.json` your browser was served; hover for the full hash, click to copy it. It should equal the `sha256:` digest GitHub shows beside the `manifest.json` asset on that release, and the hash printed by either method below. **Verify** downloads every file in the manifest again and compares each hash. Both are a convenience: a page that was tampered with could display anything, so the checks that count are the two below, run from your own terminal.

**1. Rebuild it yourself (strongest).** Node 24 and pnpm 10:

```bash
git clone https://github.com/PhiDung-hub/get-liquidated && cd get-liquidated
V=$(curl -s https://get.hyperliqui.date/_app/version.json | sed -E 's/.*"version":"([0-9.]+).*/\1/')
git checkout "v$V"                   # the release the site serves now
pnpm install --frozen-lockfile && pnpm build
pnpm verify https://get.hyperliqui.date trade-ui/build
```

`✓ … all N files match byte for byte, manifest.json sha256 …` means every HTML, script, style, font, image and sound the site serves is what you just built, and so is the `/manifest.json` it serves. Any difference prints the file and exits non-zero.

**2. Check GitHub's signed record (quick).** CI builds every release, publishes the build's `manifest.json` as a release asset with a [build attestation](https://docs.github.com/en/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds), and compares the live site with its build after each release and every 6 hours ([workflow](.github/workflows/verify.yml)):

```bash
V=$(curl -s https://get.hyperliqui.date/_app/version.json | sed -E 's/.*"version":"([0-9.]+).*/\1/')
gh release download "v$V" --repo PhiDung-hub/get-liquidated --pattern manifest.json
gh attestation verify manifest.json --repo PhiDung-hub/get-liquidated
node trade-ui/scripts/verify.mjs https://get.hyperliqui.date manifest.json
sha256sum manifest.json              # the hash the page shows
```

## What this does not prove

- **That every load is the same.** A check covers the files served to you when you ran it. A server could serve someone else different files, so check from the browser you trade in, and watch for a version you did not expect.
- **The server's own code.** `/api/*` (recorded order flow, the coin list) runs in a Cloudflare Worker that is not in this repo. The page's Content Security Policy (`svelte.config.js`) only lets it connect to this site, Hyperliquid and the local AI companion on `127.0.0.1:28657`; no route receives a key.
- **Your browser.** Extensions and malware on your machine can read any page.

## Layout

- `trade-ui/`: the app (`src/`, `static/`) and its build config.
- `agent/src/wire.ts`: types the app shares with the local AI companion; only types are used, so none of it is in the bundle.
- `trade-ui/scripts/verify.mjs`: the checker above, with no dependencies.

Tests, the Worker and the other apps stay in the private monorepo.
