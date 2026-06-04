// Slide-rail drag reorder: starting with 1 slide, add two more via Ctrl+M
// so there are 3 slides, then drag slide-3 to before slide-1 in the rail
// and verify pageOrder reflects [page-3, page-1, page-2].

import { test, expect } from '@playwright/test';

test('drag-reordering slides in the rail updates pageOrder', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  // Add 2 more slides
  await page.keyboard.press('Control+m');
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+m');
  await page.waitForTimeout(400);

  const before = await page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    return inst.getCurrentUnitOfType(3).getPageOrder();
  });
  console.log('pageOrder before drag:', before);
  expect(before.length, 'expected 3 slides for drag test').toBe(3);

  // Drag the last rail thumbnail to before the first
  const thumbs = page.locator('.cs-slide-rail__item');
  const count = await thumbs.count();
  console.log('rail thumb count:', count);
  expect(count, 'expected 3 rail items').toBe(3);

  const lastBox = await thumbs.nth(2).boundingBox();
  const firstBox = await thumbs.nth(0).boundingBox();
  if (!lastBox || !firstBox) throw new Error('couldn\'t resolve thumb boxes');
  // Drag: mousedown on last, move to first, drop slightly above the first thumb
  await page.mouse.move(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + 2, { steps: 10 });
  await page.waitForTimeout(300);
  await page.mouse.up();
  await page.waitForTimeout(700);

  const after = await page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    return inst.getCurrentUnitOfType(3).getPageOrder();
  });
  console.log('pageOrder after drag:', after);
  expect(after[0], `slide previously at index 2 should now be at index 0. before=${before.join(',')} after=${after.join(',')}`).toBe(before[2]);
});
