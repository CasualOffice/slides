// Layout picker: open the Layout dropdown from the toolbar, apply a
// non-default layout (e.g., "Title and content"), verify the active
// page's pageElements update.

import { test, expect } from '@playwright/test';

test('layout picker applies a non-default layout to the active slide', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  const readState = async () => page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const snap = unit.getSnapshot();
    return {
      slideCount: snap.body.pageOrder.length,
      perSlideElements: snap.body.pageOrder.map((pid) => Object.keys(snap.body.pages[pid].pageElements).length),
    };
  });

  const before = await readState();
  console.log('state before:', JSON.stringify(before));

  // Open the Layout dropdown
  await page.locator('.cs-toolbar button:has-text("Layout")').first().click();
  await page.waitForTimeout(500);

  // Pick a layout — try "Two content" or similar
  const tryNames = [/two content/i, /title and content/i, /section header/i, /blank/i];
  let clicked = false;
  for (const name of tryNames) {
    const btn = page.getByRole('button', { name }).first();
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click().catch(() => {});
      clicked = true;
      console.log('clicked layout matching:', String(name));
      break;
    }
  }
  if (!clicked) {
    // Fallback: click some menu item that isn't the first option
    await page.locator('[role="menu"] button, [role="dialog"] button').nth(3).click({ timeout: 3000 }).catch(() => {});
  }
  await page.waitForTimeout(1000);

  const after = await readState();
  console.log('state after:', JSON.stringify(after));

  // Default mode of the picker is "Insert" — a new slide should be
  // added with the layout's element template.
  expect(after.slideCount, `expected ${before.slideCount + 1} slides, got ${after.slideCount}`)
    .toBe(before.slideCount + 1);

  // ─── APPLY mode: replace the active slide's layout in-place
  await page.locator('.cs-toolbar button:has-text("Layout")').first().click();
  await page.waitForTimeout(400);
  // Switch the picker to "Apply" mode
  await page.getByRole('tab', { name: /apply/i }).click().catch(() => {});
  await page.waitForTimeout(200);
  const beforeApply = await readState();
  const activePageIdx = await page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const order = unit.getPageOrder();
    const activeId = unit.getActivePage()?.id;
    return order.indexOf(activeId);
  });
  console.log('active page index before apply:', activePageIdx);
  // Pick a layout that's structurally different — "Section header"
  const tryApply = [/section header/i, /title only/i, /blank/i, /title slide/i];
  let applied = false;
  for (const name of tryApply) {
    const btn = page.getByRole('button', { name }).first();
    if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
      await btn.click().catch(() => {});
      applied = true;
      console.log('applied layout matching:', String(name));
      break;
    }
  }
  expect(applied, 'an apply-layout tile should be visible').toBe(true);
  await page.waitForTimeout(800);
  const afterApply = await readState();
  console.log('apply: before active-page elements:', beforeApply.perSlideElements[activePageIdx],
    'after:', afterApply.perSlideElements[activePageIdx]);
  expect(afterApply.slideCount, 'apply should NOT add a slide').toBe(beforeApply.slideCount);
  // Some structural change on the active slide — element count likely
  // differs because different layouts have different placeholders.
  // If it doesn't change, the apply path is silently no-op.
  expect(
    afterApply.perSlideElements[activePageIdx] !== beforeApply.perSlideElements[activePageIdx]
    || JSON.stringify(afterApply) !== JSON.stringify(beforeApply),
    `apply should change the active slide's structure`,
  ).toBe(true);
});
