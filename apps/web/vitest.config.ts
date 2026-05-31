import { defineConfig } from 'vitest/config';

// Unit-test config. Lives next to vite.config.ts; intentionally simple —
// node env for the modules we cover today (autosave uses a fake-IDB
// shim, pptx-import is pure ArrayBuffer/JSZip). If we add React-tree
// tests later, flip a specific spec to environment: 'jsdom' via the
// `// @vitest-environment jsdom` pragma at the top of that file.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    // Keep the watcher off in CI; pnpm test runs `vitest run` explicitly.
    reporters: process.env.CI ? ['default'] : ['default'],
  },
});
