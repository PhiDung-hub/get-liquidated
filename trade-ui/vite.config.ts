import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// The testnet suite places real orders, so only `pnpm test:testnet` (--mode testnet) collects it.
export default defineConfig(({ mode }) => ({
  plugins: [sveltekit()],
  // Vite inlines files under 4 KiB as data: URLs, which the CSP (font-src falls back to 'self') blocks.
  build: { assetsInlineLimit: (file: string) => (file.endsWith('.woff2') ? false : undefined) },
  test: { include: ['tests/**/*.test.ts'], exclude: mode === 'testnet' ? [] : ['tests/testnet/**'], testTimeout: 30_000 }
}));
