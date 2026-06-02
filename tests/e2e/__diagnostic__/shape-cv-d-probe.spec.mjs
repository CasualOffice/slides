// Shape Ctrl+C / Ctrl+V / Ctrl+D regression net.
//
// Three sub-bugs together broke duplicate/copy/paste in 2026-06:
//   - FormatPane mirror raced with model boot; getSelectedElement()
//     returned null even when the transformer had a selection. Fixed by
//     adding a live transformer-read fallback in selection.ts.
//   - The FormatPane auto-focuses an INPUT after a paste, which made
//     App.tsx's inEditable guard short-circuit subsequent Ctrl combos.
//     Fixed by narrowing the guard to only swallow text-typing shortcuts
//     (z/y/c/x/v/a).
//   - duplicateSelectedElement() pasted on the active page, not the source
//     element's page. Fixed by cloning directly into the source page.

import { test, expect } from '@playwright/test';

test('shape Ctrl+C/V/D operate on canvas-selected element', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);
  await page.waitForFunction(() => typeof window.__casualSlides_getSelection === 'function', null, { timeout: 5000 });

  // 1. Insert rectangle via toolbar
  await page.locator('.cs-toolbar button:has-text("Insert")').first().click();
  await page.waitForTimeout(300);
  await page.getByRole('menuitem', { name: /rectangle/i }).first().click().catch(() => {});
  await page.waitForTimeout(800);

  const countOnPage1 = async () => page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const snap = unit.getSnapshot();
    const pageId = snap.body.pageOrder[0];
    const els = Object.values(snap.body.pages[pageId].pageElements);
    return els.filter((el) => !el.id?.includes('title') && !el.id?.includes('subtitle')).length;
  });

  // 2. Click the rectangle so the selection is unambiguous
  const rectCentre = await page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const snap = unit.getSnapshot();
    const pageId = snap.body.pageOrder[0];
    const els = snap.body.pages[pageId].pageElements;
    let rect;
    for (const el of Object.values(els)) {
      if (!el.id?.includes('title') && !el.id?.includes('subtitle')) { rect = el; break; }
    }
    if (!rect) return null;
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const main = canvases.reduce((b, x) => !b || x.getBoundingClientRect().width * x.getBoundingClientRect().height >
      b.getBoundingClientRect().width * b.getBoundingClientRect().height ? x : b, null);
    const r = main.getBoundingClientRect();
    const scale = r.width / unit.getPageSize().width;
    return { x: r.left + (rect.left + rect.width / 2) * scale, y: r.left + (rect.top + rect.height / 2) * scale };
  });
  if (rectCentre) {
    await page.mouse.click(rectCentre.x, rectCentre.y);
    await page.waitForTimeout(500);
  }

  // 3. Ctrl+C, Ctrl+V → expect page-1 shapes to go +1
  const after1 = await countOnPage1();
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(700);
  const after2 = await countOnPage1();
  expect(after2, `Ctrl+C/V should add a shape (was ${after1}, now ${after2})`).toBe(after1 + 1);

  // 4. Ctrl+D — duplicate on the SAME page even if the active page has
  //    shifted (here, we first add a new slide so active page ≠ source page).
  await page.keyboard.press('Control+m');
  await page.waitForTimeout(500);
  const after3 = await countOnPage1();
  await page.keyboard.press('Control+d');
  await page.waitForTimeout(700);
  const after4 = await countOnPage1();
  expect(after4, `Ctrl+D should add a shape to the SOURCE page (was ${after3}, now ${after4})`)
    .toBe(after3 + 1);
});
