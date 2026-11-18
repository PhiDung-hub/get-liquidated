import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

// The testnet suite places real orders, so only `pnpm test:testnet` (--mode testnet) collects it.
export default defineConfig(({ mode }) => ({
  plugins: [
    sveltekit(),
    {
      name: 'absolute-inlined-css-urls',
      configResolved(config) {
        const renderBuiltUrl = config.experimental.renderBuiltUrl;
        // SvelteKit's emitted stylesheet URLs are relative to the CSS file. Inlined CSS resolves from the document.
        if (renderBuiltUrl) config.experimental.renderBuiltUrl = (file, context) =>
          context.hostType === 'css' ? `/${file}` : renderBuiltUrl(file, context);
      }
    }
  ],
  // Vite inlines files under 4 KiB as data: URLs, which the CSP (font-src falls back to 'self') blocks.
  build: {
    assetsInlineLimit: (file: string) => (file.endsWith('.woff2') ? false : undefined),
    modulePreload: { resolveDependencies: (_, files) => files.slice().sort() }
  },
  test: { include: ['tests/**/*.test.ts'], exclude: mode === 'testnet' ? [] : ['tests/testnet/**'], testTimeout: 30_000 }
}));
