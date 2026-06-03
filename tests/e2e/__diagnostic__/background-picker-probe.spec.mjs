// Backgrounds picker: open the Background dropdown from the toolbar,
// pick a non-default color swatch, verify the active page's
// pageBackgroundFill updates in the model.

import { test, expect } from '@playwright/test';

test('background picker applies fill to the active slide', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  const readBg = async () => page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const snap = unit.getSnapshot();
    const pageId = snap.body.pageOrder[0];
    return snap.body.pages[pageId].pageBackgroundFill;
  });

  const before = await readBg();
  console.log('background before:', JSON.stringify(before));

  // Open the Background dropdown
  await page.locator('.cs-toolbar button:has-text("Background")').first().click();
  await page.waitForTimeout(500);

  // Pick the first non-white swatch. Use a permissive selector for the
  // color buttons inside the popover.
  const swatches = page.locator('[role="menu"] button[aria-label*="color" i], [role="dialog"] button[style*="background"], .cs-color-swatch');
  const count = await swatches.count();
  console.log('swatch count:', count);
  if (count < 2) {
    // Fallback: any small button inside the popover
    const fallback = page.locator('[role="menu"] button').nth(2);
    await fallback.click({ timeout: 3000 }).catch(() => {});
  } else {
    // Click the second-or-later swatch (avoids the "no fill" / current
    // entry at index 0).
    await swatches.nth(2).click({ timeout: 3000 }).catch(() => {});
  }
  await page.waitForTimeout(800);

  const after = await readBg();
  console.log('background after:', JSON.stringify(after));

  // Some change SHOULD have happened. If the picker click landed on the
  // same color as before, the test will be misleading — assert simply
  // that the model's pageBackgroundFill is now present and not the
  // original.
  expect(JSON.stringify(after) !== JSON.stringify(before), `background should change. before=${JSON.stringify(before)} after=${JSON.stringify(after)}`).toBe(true);
});
