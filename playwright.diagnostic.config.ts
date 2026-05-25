import { defineConfig, devices } from '@playwright/test';

// Diagnostic config — points at the live deployed URL. No webServer.
// Use for "what is actually being served right now" investigations.

export default defineConfig({
  testDir: './tests/e2e/__diagnostic__',
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'on',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
