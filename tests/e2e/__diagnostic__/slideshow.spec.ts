import { expect, test } from '@playwright/test';

// Click Slideshow → fullscreen overlay; capture a screenshot mid-show.
test('slideshow opens with first slide + advances on right arrow', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.waitForFunction(
    () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
    null,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(800);

  await page.getByRole('button', { name: /slideshow/i }).first().click();
  await page.waitForSelector('.cs-slideshow');
  await page.waitForTimeout(200);
  await page.screenshot({ path: testInfo.outputPath('slide-1.png'), fullPage: false });

  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  await page.screenshot({ path: testInfo.outputPath('slide-2.png'), fullPage: false });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await expect(page.locator('.cs-slideshow')).toHaveCount(0);
});
