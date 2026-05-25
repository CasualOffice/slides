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
});
