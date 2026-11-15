// Opens the Hyperliquid socket while the app downloads; Socket.connect adopts it. Mirrors the mainnet ENDPOINTS in src/lib/transport/network.ts.
try {
  window.__hlSocket = new WebSocket('wss://api.hyperliquid.xyz/ws');
} catch {}
