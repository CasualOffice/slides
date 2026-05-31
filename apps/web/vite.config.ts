import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `PAGES_BASE` lets the GitHub Pages workflow build for /slides/ without
// committing that path into the repo (local dev stays at /). Mirrors the
// pattern used by ../sheet/apps/web/vite.config.ts.
const base = process.env.PAGES_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5373,
    strictPort: true,
  },
  worker: {
    format: 'es',
  },
  build: {
    rollupOptions: {
      output: {
        // Vendor splitting — only for libraries where (a) we use ~all
        // of them so manual chunking doesn't defeat tree-shaking, and
        // (b) the chunk is big enough that surviving an app-code
        // redeploy in the browser cache is worth the extra request.
        // We tried bucketing @univerjs/* the same way; it broke
        // whole-bundle tree-shaking of Univer's internal cross-refs
        // and nearly doubled the total bundle from 4.2 MB → 8.6 MB.
        // Leaving Univer in the default chunk preserves Rollup's
        // cross-module dead-code elimination.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/scheduler/')
          ) {
            return 'vendor-react';
          }
          if (id.includes('i18next') || id.includes('react-i18next')) {
            return 'vendor-i18n';
          }
          return undefined;
        },
      },
    },
  },
});
