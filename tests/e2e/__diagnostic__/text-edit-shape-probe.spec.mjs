// Does text-edit work in a freshly inserted SHAPE? If yes, the bug is
// specific to the placeholder title element; if no, it's an engine-wide
// text-editor positioning issue.

import { test } from '@playwright/test';

test('shape text-edit probe', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => console.log(`[b ${m.type()}] ${m.text()}`));

  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  // Insert a Rectangle via toolbar Insert ▾
  await page.locator('.cs-toolbar button:has-text("Insert")').first().click();
  await page.waitForTimeout(300);
  await page.locator('button[aria-label="Rectangle"], button[title="Rectangle"]').first().click();
  await page.waitForTimeout(700);

  const snap1 = await page.evaluate(() => {
    const w = window;
    const inj = w.univer.__getInjector();
    const inst = inj.get(w.__casualSlides__IUniverInstanceService);
    return inst.getCurrentUnitOfType(3).getSnapshot();
  });
  const newEl = Object.values(snap1.body.pages['page-1'].pageElements).find((e) => !['el-1-title', 'el-1-subtitle'].includes(e.id));
  console.log(`new shape: id=${newEl.id} at (${newEl.left},${newEl.top}) ${newEl.width}x${newEl.height}`);

  // Compute screen position of shape centre
  const map = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const c = canvases.reduce((b, x) => !b || x.getBoundingClientRect().width * x.getBoundingClientRect().height >
      b.getBoundingClientRect().width * b.getBoundingClientRect().height ? x : b, null);
    const r = c.getBoundingClientRect();
    const w = window;
    const ru = w.univer.__getInjector().get(w.__casualSlides__IRenderManagerService)
      .getRenderById(w.univer.__getInjector().get(w.__casualSlides__IUniverInstanceService).getCurrentUnitOfType(3).getUnitId());
    return { canvas: { x: r.left, y: r.top, w: r.width, h: r.height }, scale: ru.scene.getScale?.() };
  });
  const sx = map.scale?.x ?? 1, sy = map.scale?.y ?? 1;
  const slideW = 960 * sx, slideH = 540 * sy;
  const oX = (map.canvas.w - slideW) / 2, oY = (map.canvas.h - slideH) / 2;
  const cx = map.canvas.x + oX + (newEl.left + newEl.width / 2) * sx;
  const cy = map.canvas.y + oY + (newEl.top + newEl.height / 2) * sy;

  // Single click + double click to enter text edit
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(300);
  await page.mouse.dblclick(cx, cy);
  await page.waitForTimeout(700);

  // Where is the contenteditable overlay now?
  const overlay = await page.evaluate(() => {
    const ces = Array.from(document.querySelectorAll('[contenteditable]'));
    return ces.map((e) => {
      const r = e.getBoundingClientRect();
      return { tag: e.tagName, x: r.left, y: r.top, w: r.width, h: r.height, focused: document.activeElement === e };
    });
  });
  console.log('contenteditable overlays after shape dblclick:', JSON.stringify(overlay, null, 2));

  // Type
  await page.keyboard.type('SHAPE', { delay: 60 });
  await page.waitForTimeout(500);

  // Commit
  await page.mouse.click(map.canvas.x + 20, map.canvas.y + 20);
  await page.waitForTimeout(500);

  const snap2 = await page.evaluate(() => {
    const w = window;
    return w.univer.__getInjector().get(w.__casualSlides__IUniverInstanceService).getCurrentUnitOfType(3).getSnapshot();
  });
  const shapeAfter = Object.values(snap2.body.pages['page-1'].pageElements).find((e) => e.id === newEl.id);
  console.log('shape text after typing:', shapeAfter?.shape?.text, ' richText:', shapeAfter?.richText?.text);
});
