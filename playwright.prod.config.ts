import { defineConfig, devices } from '@playwright/test';

// Prod-bundle test config. Builds the web app and serves it via `vite
// preview` so we exercise the minified bundle, not the dev server. The
// default playwright.config.ts uses the dev server and misses prod-only
// timing / minification bugs (e.g. the slide-render-controller crash that
// shipped before this config existed).

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['**/prod-smoke.spec.ts'],
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4373',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --filter @point/web exec sh -c "PAGES_BASE=/ pnpm exec vite build && pnpm exec vite preview --port 4373 --strictPort"',
    url: 'http://127.0.0.1:4373',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 180_000,
  },
});
