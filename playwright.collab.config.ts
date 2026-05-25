import { defineConfig, devices } from '@playwright/test';

// Multi-tab collab test. Spawns the @point/server inside the spec; needs
// the web dev server too. Run via `pnpm test:e2e:collab`.

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['**/collab-multitab.spec.ts'],
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5373',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --filter @point/web dev',
    url: 'http://127.0.0.1:5373',
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  },
});
