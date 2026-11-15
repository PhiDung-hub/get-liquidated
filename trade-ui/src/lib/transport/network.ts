export type Network = 'mainnet' | 'testnet';
export const ENDPOINTS: Record<Network, { http: string; ws: string }> = {
  mainnet: { http: 'https://api.hyperliquid.xyz', ws: 'wss://api.hyperliquid.xyz/ws' },
  testnet: { http: 'https://api.hyperliquid-testnet.xyz', ws: 'wss://api.hyperliquid-testnet.xyz/ws' }
};

// Mainnet only for now; `pnpm test:testnet` (Vite mode testnet) is the one way onto testnet.
const current: Network = import.meta.env.MODE === 'testnet' ? 'testnet' : 'mainnet';
export const net = { current, isMainnet: current === 'mainnet' } as const;
