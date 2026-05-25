import { expect, test } from '@playwright/test';

// Diagnostic: screenshot the new chrome to confirm visual polish.
test('shell screenshot — visual review', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.waitForFunction(
    () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
    null,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(1200);
  await page.screenshot({ path: testInfo.outputPath('shell.png'), fullPage: false });
  // Also capture with the File menu open so the dropdown is visible.
  await page.getByRole('button', { name: 'File' }).click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: testInfo.outputPath('shell-file-menu.png'), fullPage: false });
  expect(true).toBe(true);
});
