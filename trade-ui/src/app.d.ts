declare global {
  interface Window {
    __hlSocket?: WebSocket;
    __hlLedger?: typeof import('$lib/exchange/ledger.svelte').ledger | null;
    ethereum?: import('$lib/session/wallet.svelte').WalletProvider;
    phantom?: { ethereum?: import('$lib/session/wallet.svelte').WalletProvider };
    rabby?: import('$lib/session/wallet.svelte').WalletProvider;
  }
}
export {};
