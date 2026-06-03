import { expect, test } from '@playwright/test';

test('theme picker opens via toolbar + applies background to all slides', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.waitForFunction(
    () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
    null,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(800);

  // Capture pre-apply screenshot for visual review.
  await page.screenshot({ path: testInfo.outputPath('before.png') });

  // Toolbar Theme button.
  await page.getByRole('button', { name: /^theme$/i }).click();
  await expect(page.locator('.cs-themepicker')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('picker.png') });

  // Reset capture, click the Graphite theme card.
  await page.evaluate(() => {
    (window as { __capturedMutations: string[] }).__capturedMutations = [];
  });
  await page.getByRole('button', { name: /graphite/i }).click();
  await page.waitForTimeout(400);

  // Should have dispatched one update-page mutation per slide. The default
  // deck has 1 slide as of the Spike-A → single-blank-slide change.
  const captured = await page.evaluate(() => [...(window as { __capturedMutations: string[] }).__capturedMutations]);
  expect(captured.filter((m) => m === 'slide.mutation.update-page').length).toBeGreaterThanOrEqual(1);

  await page.screenshot({ path: testInfo.outputPath('after.png') });
});
