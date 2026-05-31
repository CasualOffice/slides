import { defineConfig } from 'vitest/config';

// Unit-test config for the server. Pure node env — the only module we
// cover today is the static-file handler, which talks to `node:fs` +
// `node:http`. No DOM, no React.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
