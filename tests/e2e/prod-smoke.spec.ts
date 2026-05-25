import { expect, test } from '@playwright/test';

// Prod-bundle smoke. The default e2e config drives the Vite dev server,
// which is lazier about plugin init ordering than the minified production
// bundle — the Univer slide-render-controller bug (_createSlide reaching
// for getCurrentUnitOfType()! before the unit is current) reproduces only
// against `vite preview`. Run via:
//
//   pnpm exec playwright test tests/e2e/prod-smoke.spec.ts --config=playwright.prod.config.ts

test('prod build mounts Univer without TypeError', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });

  await page.goto('/');
  await page.waitForTimeout(2000);

  const fatal = errors.filter((e) => !e.includes('fonts.googleapis') && !e.includes('favicon'));
  expect(fatal, `prod console errors:\n${fatal.join('\n')}`).toEqual([]);
});
