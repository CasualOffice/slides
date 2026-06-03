// Drag-and-drop an image onto the canvas; verify it appears as a new
// pageElement on the active slide.

import { test, expect } from '@playwright/test';

test('drag-drop image inserts a pageElement', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  // Tiny 1x1 PNG (transparent), base64 encoded
  const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4//8/AwAI/AL+XJ/PVAAAAABJRU5ErkJggg==';

  const before = await page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const snap = unit.getSnapshot();
    const pageId = snap.body.pageOrder[0];
    return Object.keys(snap.body.pages[pageId].pageElements).length;
  });
  console.log('elements before:', before);

  // Drop via the canvas drop event
  await page.evaluate(async ({ b64 }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'tiny.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    // Locate the canvas-host workspace; drop event needs to fire on the
    // container that handles dragenter/dragover/drop
    const target = document.querySelector('.cs-workspace') || document.querySelector('.univer-mount') || document.body;
    const dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(dropEvent);
  }, { b64: pngB64 });

  await page.waitForTimeout(2000);

  const after = await page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const snap = unit.getSnapshot();
    const pageId = snap.body.pageOrder[0];
    const els = snap.body.pages[pageId].pageElements;
    const out = { count: Object.keys(els).length, byKind: {} };
    for (const el of Object.values(els)) {
      const kind = el.image ? 'image' : el.shape ? 'shape' : el.richText ? 'text' : el.title ? 'placeholder' : 'unknown';
      out.byKind[kind] = (out.byKind[kind] ?? 0) + 1;
    }
    return out;
  });
  console.log('elements after:', JSON.stringify(after));
  expect(after.byKind?.image ?? 0, 'drop should add an image element').toBeGreaterThan(0);
});
