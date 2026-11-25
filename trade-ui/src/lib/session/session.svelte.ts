import { discoverWallets, selectedWallet, parseAccounts, walletChoices, wallets } from './wallet.svelte';
import { ENDPOINTS, net, type Network } from '$lib/transport/network';
import { inventory } from '$lib/account/inventory.svelte';
import { info } from '$lib/transport/info';
import { load, save } from '$lib/util/storage';
import { addressOf, hexToKey, keyToHex, newKey, parseWalletSignature, signDigest } from '$lib/signing/keys';
import { approveAgentTypedData, type ApproveAgentAction } from '$lib/signing/userSigned';
import { l1Digest } from '$lib/signing/l1';
import { noopAction } from '$lib/exchange/actions';
import { sendUserSigned, type Signer } from '$lib/exchange/send';
import { nextNonce } from '$lib/exchange/nonce';
import type { LinkPayload } from '$lib/session/link';
import { fmtAddr } from '$lib/util/format';
import { toast } from '$lib/ui/toast.svelte';
import { busy } from '$lib/orders/chase.svelte';
import { sweep } from '$lib/orders/sweep.svelte';
import { queued } from '$lib/hotkeys/armed.svelte';
import { closing, placing } from '$lib/orders/ticket.svelte';
import { forgetSizes, useSizes } from '$lib/settings/settings.svelte';

type StoredAgent = { key: string; address: string };
export type ExtraAgent = { name: string; address: string; validUntil: number | null };
export const AGENT_NAME = 'trade-ui';
export const PHONE_AGENT_NAME = 'trade-ui-phone';
const ZERO_ADDRESS = '0x' + '0'.repeat(40);
const AGENT_TTL_MS = 90 * 86_400_000;

export const session = $state({
  master: null as string | null,
  watch: null as string | null,
  agent: null as { address: string; validUntil: number | null } | null,
  holdsSigner: false,
  readOnlyReason: '',
  linked: false
});

let agentKey: Uint8Array | null = null;
/** Bumped on every account change, so an await that resolves after one leaves the new account alone. */
let gen = 0;
const storeKey = (master: string, n: Network = net.current) => `trade-ui:agent:${n}:${master}`;
const linkedKey = (n: Network) => `trade-ui:linked:${n}`;
const ADDR = /^0x[0-9a-f]{40}$/;
export const viewAddress = () => session.master ?? session.watch;

export type Account = { address: string; label: string };
type SavedAccounts = { active?: unknown; list?: unknown };
const accountsKey = `trade-ui:accounts:${net.current}`;
const parseList = (s: SavedAccounts) => (Array.isArray(s.list) ? s.list : [])
  .filter((a): a is Account => typeof a?.address === 'string' && ADDR.test(a.address) && typeof a.label === 'string');
/** A linked phone keeps its own list of linked accounts; before 1.2.9 it held just the one address. */
function linkedAccounts(n: Network = net.current): SavedAccounts | null {
  const v = load<unknown>(linkedKey(n), null);
  const saved = typeof v === 'string' ? { active: v, list: [{ address: v, label: '' }] } : (v as SavedAccounts | null);
  return saved && typeof saved === 'object' && parseList(saved).length ? saved : null;
}
const savedAccounts = load<SavedAccounts>(accountsKey, {});
export const accounts = $state({ list: parseList(savedAccounts) });
const saveAccounts = () => save(session.linked ? linkedKey(net.current) : accountsKey, { active: session.master, list: accounts.list });
const listed = (address: string) => accounts.list.some((a) => a.address === address);
function addAccount(address: string) {
  const a = address.toLowerCase();
  if (!listed(a)) accounts.list = [...accounts.list, { address: a, label: '' }];
  if (offer?.address === a) dropOffer();
  return a;
}
export function renameAccount(address: string, label: string) {
  accounts.list = accounts.list.map((a) => (a.address === address ? { ...a, label: label.trim().slice(0, 24) } : a));
  saveAccounts();
}
/**
 * A wallet account keeps its saved agent key, so adding it back trades again without a new approval; a linked account's
 * phone key goes with it, as only a new link brings it back. Its sizes are forgotten.
 */
export function removeAccount(address: string) {
  if (address === session.master) throw new Error('switch to another account before removing this one');
  accounts.list = accounts.list.filter((a) => a.address !== address);
  if (session.linked) save(storeKey(address), null);
  saveAccounts();
  forgetSizes(address);
}
export const savedAgent = (master: string) => load<StoredAgent | null>(storeKey(master), null)?.address ?? null;

/**
 * Asks the browser not to evict the key (Safari grants it to Home Screen apps, Chrome to installed or much-used sites);
 * false when the browser would not store it (full, blocked or private storage).
 */
function storeAgent(master: string, agent: StoredAgent, n: Network = net.current) {
  save(storeKey(master, n), agent);
  navigator.storage?.persist?.().catch((e) => console.warn('storage: could not ask to persist', e));
  return load<StoredAgent | null>(storeKey(master, n), null)?.address === agent.address;
}

const SIGNER_ELSEWHERE = 'read-only: another tab holds the signer';
let claim: AbortController | null = null;
let visible = $state(true);

/** Resolves once this page holds the signer or waits in line behind the page that does; aborting the claim gives it up. */
function claimSigner(): Promise<void> {
  if (claim) return Promise.resolve();
  if (!globalThis.navigator?.locks) return Promise.resolve(void (session.readOnlyReason = 'read-only: needs a secure context to hold the signer'));
  const c = (claim = new AbortController());
  const name = `trade-ui-signer:${net.current}`;
  const hold = (lock: Lock | null) => {
    if (!lock || c.signal.aborted) return;
    Object.assign(session, { holdsSigner: true, readOnlyReason: '' });
    return new Promise<void>((release) => c.signal.addEventListener('abort', () => release()));
  };
  return new Promise((done) => {
    const firstTry = (lock: Lock | null) => {
      done();
      if (lock || c.signal.aborted) return hold(lock);
      session.readOnlyReason = SIGNER_ELSEWHERE;
      navigator.locks.request(name, { signal: c.signal }, (lock) => (lock && !c.signal.aborted && adoptStored(), hold(lock))).catch(() => {});
    };
    navigator.locks.request(name, { ifAvailable: true }, firstTry).catch((e) => done(void (session.readOnlyReason = `read-only: ${e.message}`)));
  });
}

/** The tab that held the signer may have approved a new key meanwhile; trade on it rather than ask for another approval. */
function adoptStored() {
  const stored = session.master && load<StoredAgent | null>(storeKey(session.master), null);
  if (!stored || stored.address === session.agent?.address) return;
  agentKey = hexToKey(stored.key);
  session.agent = { address: stored.address, validUntil: null };
  warmUp();
  refreshAgentExpiry().catch((e) => toast.error(e.message));
}

function dropSigner() {
  claim?.abort();
  claim = null;
  Object.assign(session, { holdsSigner: false, readOnlyReason: session.master ? 'read-only: in the background' : '' });
}

/** A page in the background hands the signer on once nothing it started is in flight, so another tab or the installed app can trade. */
export const inFlight = () => busy() || placing.busy || closing.n > 0 || sweep.busy || queued();
const syncSigner = () => (session.master && (visible || inFlight()) ? claimSigner() : dropSigner());

const walletAccounts = async (provider = wallet()) => parseAccounts(await provider.request({ method: 'eth_accounts' }));
export const wallet = selectedWallet;
let walletPending = $state(false);
const walletBlocked = () => inFlight() || walletPending;
export const walletReady = () => !walletBlocked();

export async function initSession() {
  const u = new URLSearchParams(location.search).get('user');
  if (u && /^0x[0-9a-fA-F]{40}$/.test(u)) session.watch = u.toLowerCase();
  discoverWallets(followWallet);
  if (session.watch) return;
  const linked = linkedAccounts();
  if (linked) {
    session.linked = true;
    accounts.list = parseList(linked);
    return useMaster(listed(String(linked.active)) ? String(linked.active) : accounts.list[0].address);
  }
  const active = typeof savedAccounts.active === 'string' && listed(savedAccounts.active) ? savedAccounts.active : null;
  if (active) return useMaster(active);
  const [account] = await walletAccounts().catch(() => []);
  if (account && (!accounts.list.length || listed(account))) return useMaster(addAccount(account));
}

let deferred: { accounts: string[]; drop: () => void } | null = null;
let offer: { address: string; drop: () => void } | null = null;
function dropOffer() {
  offer?.drop();
  offer = null;
}

/** Lists the account the wallet switched to and trades on it, only once Connect is clicked; while busy it is listed and followed once idle. */
async function connectOffered(account: string) {
  if (!walletBlocked() || !session.master) return useMaster(addAccount(account));
  addAccount(account);
  saveAccounts();
  deferred?.drop();
  deferred = { accounts: [account], drop: toast.sticky(`Added ${fmtAddr(account)} — finish or stop your chases on ${fmtAddr(session.master)} to follow it`) };
}

/**
 * While chases or orders are in flight the agent keeps signing for the current account, so the switch waits for them.
 * A locked wallet reports no account; the agent needs no wallet, so the session stays. An account not in the list
 * joins it only from Connect.
 */
function followWallet(value: unknown) {
  let accounts: string[];
  try { accounts = parseAccounts(value); } catch (e) { toast.error((e as Error).message); return; }
  deferred?.drop();
  deferred = null;
  dropOffer();
  const account = accounts?.[0]?.toLowerCase();
  if (!account || !session.master || session.linked || account === session.master) return;
  if (walletBlocked()) {
    deferred = { accounts, drop: toast.sticky(`Wallet switched to ${fmtAddr(account)} — finish or stop your chases on ${fmtAddr(session.master)} to ${listed(account) ? 'follow' : 'connect'} it`) };
    return;
  }
  if (!listed(account)) {
    const run = () => void connectOffered(account).catch((e) => toast.error(e.message));
    offer = { address: account, drop: toast.sticky(`Wallet switched to ${fmtAddr(account)}, not in your accounts — orders still go to ${fmtAddr(session.master)}`, { label: 'Connect', run }) };
    return;
  }
  // The wallet, not this page, moved the account: the next order goes to it, so say so.
  toast.info(`Wallet switched to ${fmtAddr(account)}: orders now go to this account`);
  useMaster(addAccount(account)).catch((e) => toast.error(e.message));
}

export const resumeWallet = () => deferred && followWallet(deferred.accounts);

export async function connectWallet() {
  if (walletBlocked()) throw new Error('Wait for pending wallet requests, orders and chases before connecting');
  const provider = wallet();
  walletPending = true;
  try {
    const [a] = parseAccounts(await provider.request({ method: 'eth_requestAccounts' }));
    if (!a) throw new Error('Unlock your wallet and try again');
    if (inFlight()) throw new Error('Wait for pending orders before switching account');
    session.linked = false;
    save(linkedKey(net.current), null);
    await useMaster(addAccount(a));
  } finally { walletPending = false; }
}

/** Asks the wallet to pick accounts where it can (MetaMask's account chooser), then lists and switches to its current one once idle. */
export async function addWalletAccount(refusal: () => string) {
  if (walletBlocked()) throw new Error('Wait for pending wallet requests, orders and chases before adding an account');
  const provider = wallet();
  walletPending = true;
  try {
    const before = session.master;
    await provider
      .request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] })
      .catch((e) => {
        if (e?.code === 4001) throw new Error('Cancelled in your wallet');
      });
    const [a] = parseAccounts(await provider.request({ method: 'eth_requestAccounts' }));
    const account = a?.toLowerCase();
    if (!account) throw new Error('Unlock your wallet and try again');
    if (account === before) return void toast.error(`Your wallet is still on ${fmtAddr(before)} — switch it to the new account, then Add account`);
    if (account === session.master) return;
    if (listed(account)) throw new Error(`Your wallet is on ${fmtAddr(account)}, already in the list — switch it to the new account, or pick ${fmtAddr(account)} from the list`);
    addAccount(account);
    saveAccounts();
    const why = refusal();
    if (why) throw new Error(`Added ${fmtAddr(account)} to the list; ${why}`);
    await useMaster(account);
  } finally { walletPending = false; }
}

export async function useMaster(address: string) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Invalid account address');
  dropOffer();
  const g = ++gen;
  agentKey = null;
  session.agent = null;
  session.master = address.toLowerCase();
  useSizes(session.master);
  saveAccounts();
  await syncSigner();
  if (g !== gen) return;
  const stored = load<StoredAgent | null>(storeKey(session.master), null);
  agentKey = stored ? hexToKey(stored.key) : null;
  session.agent = stored ? { address: stored.address, validUntil: null } : null;
  if (!stored) return;
  warmUp();
  await refreshAgentExpiry();
}

// First secp256k1 sign pays ~40ms of table setup; do it before the first real order, then warm msgpack, keccak and the JIT in idle time. Nothing is sent and no nonce is used.
function warmUp() {
  const key = agentKey;
  if (!key) return;
  const sign = () => signDigest(l1Digest(noopAction(), 0, net.isMainnet), key);
  setTimeout(() => {
    sign();
    (globalThis.requestIdleCallback ?? setTimeout)(() => {
      for (let i = 0; i < 4; i++) sign();
    });
  }, 3000);
}

export async function refreshAgentExpiry() {
  const { master, agent } = session;
  if (!master || !agent) return;
  const g = gen;
  const agents = await info<ExtraAgent[]>({ type: 'extraAgents', user: master });
  if (g !== gen || session.agent?.address !== agent.address) return;
  if (!Array.isArray(agents)) throw new Error('Could not check the trading key: Hyperliquid sent no agent list — it is kept');
  const mine = agents.find((a) => String(a?.address).toLowerCase() === agent.address);
  if (mine) return void (agent.validUntil = mine.validUntil);
  save(storeKey(master), null);
  agentKey = null;
  session.agent = null;
  throw new Error(session.linked ? "this phone's key is no longer approved — make a new link on the desktop" : 'Stored agent is no longer approved on the exchange — enable trading again');
}

/**
 * Follows the page into and out of view for the signer, and a phone back in view checks its key at once, so a revoke
 * from the desktop shows before its next order is refused.
 */
export function startRecheck() {
  const seen = () => (visible = document.visibilityState === 'visible');
  const check = () => seen() && session.linked && refreshAgentExpiry().catch((e) => toast.error(e.message));
  seen();
  document.addEventListener('visibilitychange', check);
  addEventListener('pagehide', seen);
  addEventListener('pageshow', seen);
  const stop = $effect.root(() => {
    $effect(() => void syncSigner());
  });
  return () => {
    stop();
    document.removeEventListener('visibilitychange', check);
    removeEventListener('pagehide', seen);
    removeEventListener('pageshow', seen);
  };
}

async function walletApprove(master: string, agentAddress: string, agentName: string, verify?: () => Promise<void>) {
  const network = net.current;
  const generation = gen;
  const unchanged = () => {
    if (gen !== generation || net.current !== network || session.master !== master || session.linked) throw new Error('Account or network changed — try again');
  };
  if (walletPending) throw new Error('Wait for the pending wallet request');
  const provider = wallet();
  walletPending = true;
  try {
    const account = (await walletAccounts(provider))[0];
    if (!account) throw new Error('Unlock your wallet and try again');
    if (account !== master) throw new Error(`Your wallet is on ${fmtAddr(account)} — switch it to ${fmtAddr(master)} and try again`);
    const chainId = (await provider.request({ method: 'eth_chainId' })) as string;
    unchanged();
    const action: ApproveAgentAction = {
      type: 'approveAgent', hyperliquidChain: net.isMainnet ? 'Mainnet' : 'Testnet', signatureChainId: chainId,
      agentAddress, agentName, nonce: Date.now()
    };
    const raw = (await provider
      .request({ method: 'eth_signTypedData_v4', params: [master, JSON.stringify(approveAgentTypedData(action))] })
      .catch((e) => {
        throw e?.code === 4001 ? new Error('Approval cancelled in your wallet') : e;
      })) as string;
    unchanged();
    await verify?.();
    unchanged();
    await sendUserSigned(action, parseWalletSignature(raw));
  } finally { walletPending = false; }
}

export async function enableTrading() {
  const master = session.master;
  if (!master) throw new Error('Connect a wallet first');
  if (!session.holdsSigner) throw new Error(session.readOnlyReason);
  const g = gen;
  const key = newKey();
  const address = addressOf(key);
  const validUntil = Date.now() + AGENT_TTL_MS;
  await walletApprove(master, address, `${AGENT_NAME} valid_until ${validUntil}`);
  const kept = storeAgent(master, { key: keyToHex(key), address });
  if (g !== gen) return;
  agentKey = key;
  session.agent = { address, validUntil };
  warmUp();
  if (!kept) toast.error('This browser would not store the trading key — it trades in this tab until you close or reload it; free up site storage, then enable trading again');
}

export function signer(): Signer {
  if (!session.holdsSigner) throw new Error(session.readOnlyReason || 'Connect a wallet first');
  if (!agentKey || !session.agent) throw new Error('Enable trading first (approve the trade-ui agent)');
  const agent = session.agent.address;
  return { key: agentKey, isMainnet: net.isMainnet, nextNonce: () => nextNonce(agent) };
}

/**
 * A fresh key per phone, approved by the wallet under one name, so a new link replaces the account's previous phone and
 * Hyperliquid expires the key itself. The desktop's own agent is untouched and the phone key is never stored here.
 */
export async function approvePhone(): Promise<LinkPayload> {
  const master = session.master;
  if (!master || session.linked || !session.holdsSigner) throw new Error(session.readOnlyReason || 'Connect a wallet first');
  const key = newKey();
  const agentAddr = addressOf(key);
  await walletApprove(master, agentAddr, `${PHONE_AGENT_NAME} valid_until ${Date.now() + AGENT_TTL_MS}`);
  return { net: net.current, master, agentKey: keyToHex(key), agentAddr, ts: Date.now() };
}

export async function revokeDevice(device: ExtraAgent & { agentName?: string }) {
  const master = session.master;
  const network = net.current;
  const generation = gen;
  if (!master || session.linked || !session.holdsSigner) throw new Error(session.readOnlyReason || 'Connect the source wallet to remove devices');
  if (walletBlocked()) throw new Error('Wait for pending wallet requests, orders and chases before removing a device');
  const name = device.agentName ?? device.name;
  const address = device.address.toLowerCase();
  if (!ADDR.test(address) || address === ZERO_ADDRESS || typeof name !== 'string' || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Invalid device');
  if (address === session.agent?.address.toLowerCase()) throw new Error('You cannot remove this device from itself');
  const verify = async () => {
    if (gen !== generation || net.current !== network || session.master !== master || session.linked || !session.holdsSigner) throw new Error('Account or network changed — refresh Devices');
    const devices = name ? await info<ExtraAgent[]>({ type: 'extraAgents', user: master }) : inventory.unnamedAgent ? [{ name: '', ...inventory.unnamedAgent }] : [];
    if (!Array.isArray(devices)) throw new Error('Devices could not be verified');
    const matches = devices.filter((d) => d.name === name);
    if (matches.length !== 1 || matches[0].address.toLowerCase() !== address) throw new Error('Device approval changed — refresh Devices before removing it');
  };
  await verify();
  await walletApprove(master, ZERO_ADDRESS, name, verify);
  if (!name && inventory.unnamedAgent?.address.toLowerCase() === address) inventory.unnamedAgent = null;
}

/** Over REST to the payload's own network: the socket only talks to the network this page loaded with. */
async function agentsOn(n: Network, user: string): Promise<{ address: string }[]> {
  const res = await fetch(ENDPOINTS[n].http + '/info', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'extraAgents', user }), signal: AbortSignal.timeout(5000)
  }).catch((e) => {
    throw new Error(e?.name === 'TimeoutError' ? 'Hyperliquid did not answer in time — tap Link to try again' : `Could not reach Hyperliquid (${e.message}) — tap Link to try again`);
  });
  if (!res.ok) throw new Error(res.status === 429 ? 'Hyperliquid is rate limiting — wait a moment, then tap Link again' : `Hyperliquid answered ${res.status} — tap Link to try again`);
  const agents = await res.json().catch(() => null);
  if (!Array.isArray(agents)) throw new Error('Hyperliquid sent no agent list — tap Link to try again');
  return agents;
}

/** Stores a phone-link agent beside the phone's other linked accounts, then reloads so initSession switches to it. */
export async function adoptLinked(p: LinkPayload): Promise<void> {
  if (p.net !== net.current) throw new Error(`this link is for ${p.net}; this app trades ${net.current} only`);
  if (addressOf(hexToKey(p.agentKey)) !== p.agentAddr) throw new Error('malformed link');
  const list = parseList(linkedAccounts(p.net) ?? {});
  const known = list.some((a) => a.address === p.master);
  // A wallet browser trades with its own agent, which a phone key must never overwrite.
  const own = !known && load<unknown>(storeKey(p.master, p.net), null);
  if (own || (!session.linked && session.master) || (walletChoices().some((c) => c.id === wallets.selected) && (await walletAccounts()).length)) throw new Error('this browser already trades with a wallet; disconnect it first');
  const agents = await agentsOn(p.net, p.master);
  if (!agents.some((a) => String(a?.address).toLowerCase() === p.agentAddr)) throw new Error('this phone key is no longer approved — make a new link on the desktop');
  if (!storeAgent(p.master, { key: p.agentKey, address: p.agentAddr }, p.net)) throw new Error('This browser would not store the phone key — free up site storage or leave private browsing, then tap Link again');
  save(linkedKey(p.net), { active: p.master, list: known ? list : [...list, { address: p.master, label: '' }] });
  location.reload();
}

/** A linked phone forgets the current account's key and moves to its next linked account, if it has one. */
export async function disconnect() {
  const master = session.master;
  const rest = session.linked ? accounts.list.filter((a) => a.address !== master) : [];
  dropOffer();
  gen++;
  if (master) save(storeKey(master), null);
  agentKey = null;
  if (rest.length) {
    accounts.list = rest;
    return useMaster(rest[0].address);
  }
  save(linkedKey(net.current), null);
  if (session.linked) accounts.list = parseList(load<SavedAccounts>(accountsKey, {}));
  Object.assign(session, { master: null, agent: null, linked: false });
  useSizes(null);
  saveAccounts();
  dropSigner();
}
