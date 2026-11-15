import { load, save } from '$lib/util/storage';

export type WalletProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: 'accountsChanged', listener: (accounts: unknown) => void): unknown;
  removeListener?(event: 'accountsChanged', listener: (accounts: unknown) => void): unknown;
  providers?: WalletProvider[];
  isMetaMask?: boolean;
  isPhantom?: boolean;
  isRabby?: boolean;
};
type Choice = { id: string; name: string; provider: WalletProvider; announced: boolean };
const key = 'trade-ui:wallet';
const stored = load<unknown>(key, null);
export const wallets = $state({ selected: typeof stored === 'string' && stored.length <= 255 ? stored : '' });
let choices = $state.raw<Choice[]>([]);
export const walletChoices = () => choices;
let started = false;
let listener: ((accounts: unknown) => void) | undefined;
let detach = () => {};
const validProvider = (value: unknown): value is WalletProvider => !!value && typeof value === 'object' && typeof (value as WalletProvider).request === 'function';

function bind() {
  detach();
  const provider = choices.find((c) => c.id === wallets.selected)?.provider;
  let active = true;
  const changed = (accounts: unknown) => active && listener?.(accounts);
  provider?.on?.('accountsChanged', changed);
  detach = () => {
    active = false;
    provider?.removeListener?.('accountsChanged', changed);
  };
}

function add(choice: Choice) {
  const old = choices.find((c) => c.id === choice.id || c.provider === choice.provider);
  if (old?.announced || (old && !choice.announced)) return;
  choices = [...choices.filter((c) => c !== old), choice];
  if (old?.id === wallets.selected) {
    wallets.selected = choice.id;
    save(key, choice.id);
    bind();
  } else if (choice.id === wallets.selected) bind();
}

export function discoverWallets(onAccounts: (accounts: unknown) => void) {
  listener = onAccounts;
  if (started) return;
  started = true;
  window.addEventListener('eip6963:announceProvider', (event) => {
    const detail = (event as CustomEvent).detail;
    const info = detail?.info;
    if (!validProvider(detail?.provider) || !info || typeof info.name !== 'string' || !info.name.trim() || info.name.length > 80 || /[\x00-\x1f\x7f]/.test(info.name)) return;
    if (typeof info.rdns !== 'string' || info.rdns.length > 253 || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(info.rdns)) return;
    if (typeof info.uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(info.uuid)) return;
    if (typeof info.icon !== 'string' || !info.icon.startsWith('data:image/')) return;
    add({ id: info.rdns.toLowerCase(), name: info.name.trim(), provider: detail.provider, announced: true });
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const injected = window.ethereum;
  const legacy = [...(Array.isArray(injected?.providers) ? injected.providers : []), window.phantom?.ethereum, window.rabby];
  if (!Array.isArray(injected?.providers) && injected) legacy.push(injected);
  for (const provider of legacy) {
    if (!validProvider(provider)) continue;
    const [id, name] = provider.isRabby ? ['io.rabby', 'Rabby'] : provider.isPhantom ? ['app.phantom', 'Phantom'] : provider.isMetaMask ? ['io.metamask', 'MetaMask'] : ['legacy.browser', 'Browser wallet'];
    add({ id, name, provider, announced: false });
  }
  if (!wallets.selected && choices.length) {
    const preferred = choices.find((c) => c.provider === window.ethereum && c.announced)
      ?? choices.find((c) => c.id === 'io.rabby')
      ?? choices.find((c) => c.id === 'io.metamask')
      ?? choices.find((c) => c.announced)
      ?? choices[0];
    selectWallet(preferred.id);
  }
  else bind();
}

function selectWallet(id: string) {
  if (!choices.some((c) => c.id === id)) throw new Error('Wallet is unavailable — enable its extension and reload');
  wallets.selected = id;
  save(key, id);
  bind();
}

export function selectedWallet() {
  const choice = choices.find((c) => c.id === wallets.selected);
  if (!choice) throw new Error(wallets.selected ? 'Connected wallet is unavailable — enable its extension and reload' : 'No wallet detected — enable a wallet extension and reload');
  return choice.provider;
}

export function parseAccounts(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a))) throw new Error('Wallet returned invalid accounts');
  return [...new Set(value.map((a: string) => a.toLowerCase()))];
}
