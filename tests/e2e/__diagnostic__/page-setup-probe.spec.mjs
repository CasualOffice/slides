// Page Setup: open File menu → Page setup, switch to Standard 4:3, verify
// the model's pageSize updated from 960×540 to 960×720 (or whatever the
// 4:3 dimensions are).

import { test, expect } from '@playwright/test';

test('Page Setup changes pageSize to 4:3', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  const readSize = async () => page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    return inst.getCurrentUnitOfType(3).getPageSize();
  });

  const before = await readSize();
  console.log('size before:', JSON.stringify(before));

  // Open File menu → Page setup
  await page.getByRole('button', { name: /^File$/ }).click();
  await page.waitForTimeout(300);
  // Find a menuitem matching "page setup" / "page size"
  const tries = [/page setup/i, /page size/i, /slide size/i];
  let clicked = false;
  for (const r of tries) {
    const m = page.locator('button, [role="menuitem"]').filter({ hasText: r }).first();
    if (await m.isVisible({ timeout: 500 }).catch(() => false)) {
      await m.click();
      clicked = true;
      console.log('clicked menu matching:', String(r));
      break;
    }
  }
  expect(clicked, 'expected Page Setup menu item').toBe(true);

  await page.waitForTimeout(500);

  // Page Setup uses radio inputs. Click the label wrapping the
  // "Standard 4:3" radio, then click Apply.
  const radioLabel = page.locator('.cs-pagesetup__option').filter({ hasText: /standard 4:3/i }).first();
  await radioLabel.click({ timeout: 2000 });
  await page.waitForTimeout(200);
  console.log('picked size: Standard 4:3');

  // Click Apply
  const applyBtn = page.locator('.cs-pagesetup button.cs-btn--accent, .cs-pagesetup button').filter({ hasText: /^apply$/i }).first();
  await applyBtn.click({ timeout: 2000 });
  await page.waitForTimeout(700);

  const after = await readSize();
  console.log('size after:', JSON.stringify(after));
  // 16:9 default = 960×540 (ratio 1.78). 4:3 = 960×720 (ratio 1.33).
  // Just assert the ratio flipped to <1.5.
  const beforeRatio = before.width / before.height;
  const afterRatio = after.width / after.height;
  console.log(`ratio: before=${beforeRatio.toFixed(2)} after=${afterRatio.toFixed(2)}`);
  expect(afterRatio < beforeRatio - 0.1, `expected ratio to flip from ${beforeRatio} to <1.5 for 4:3`).toBe(true);
});
