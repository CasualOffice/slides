import { defineConfig, devices } from '@playwright/test';

// Diagnostic config — points at the live deployed URL. No webServer.
// Use for "what is actually being served right now" investigations.

export default defineConfig({
  testDir: './tests/e2e/__diagnostic__',
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5373',
    trace: 'retain-on-failure',
    screenshot: 'on',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --filter @point/web dev',
    url: 'http://127.0.0.1:5373',
    reuseExistingServer: true,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  },
});
