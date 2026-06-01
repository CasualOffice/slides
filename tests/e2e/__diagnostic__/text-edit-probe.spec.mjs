// Deep probe — why doesn't typing into the title element commit to model?
// Specifically: does dblclick enter text-edit mode? Where do keystrokes go?

import { test } from '@playwright/test';

test('text-edit deep probe', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });

  page.on('console', (msg) => console.log(`[b ${msg.type()}] ${msg.text()}`));

  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  // Find main canvas (largest)
  const map = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const c = canvases.reduce((b, x) => !b || x.getBoundingClientRect().width * x.getBoundingClientRect().height >
      b.getBoundingClientRect().width * b.getBoundingClientRect().height ? x : b, null);
    const r = c.getBoundingClientRect();
    const w = window;
    const inj = w.univer.__getInjector();
    const inst = inj.get(w.__casualSlides__IUniverInstanceService);
    const model = inst.getCurrentUnitOfType(3);
    const snap = model.getSnapshot();
    const renderMgr = inj.get(w.__casualSlides__IRenderManagerService);
    const ru = renderMgr.getRenderById(model.getUnitId());
    return {
      canvas: { x: r.left, y: r.top, w: r.width, h: r.height },
      scale: ru.scene.getScale?.() ?? null,
      page: snap.body.pages['page-1'],
    };
  });
  const sx = map.scale?.x ?? 1, sy = map.scale?.y ?? 1;
  const sw = map.page.pageElements['el-1-title'];
  const slideW = 960 * sx, slideH = 540 * sy;
  const oX = (map.canvas.w - slideW) / 2, oY = (map.canvas.h - slideH) / 2;
  const cx = map.canvas.x + oX + (sw.left + sw.width / 2) * sx;
  const cy = map.canvas.y + oY + (sw.top + sw.height / 2) * sy;
  console.log(`title centre @ ${cx.toFixed(0)},${cy.toFixed(0)}  (scale ${sx}x${sy})`);

  // Single click — selects
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(400);

  // Dump active element + DOM state after click
  const after1 = await page.evaluate(() => ({
    active: document.activeElement?.tagName,
    activeCls: typeof document.activeElement?.className === 'string'
      ? document.activeElement.className.split(' ').slice(0, 3).join(' ')
      : '',
    isContentEditable: !!document.activeElement?.isContentEditable,
    bodyChildren: document.body.children.length,
    // Look for anything that resembles a text-edit overlay
    editOverlays: Array.from(document.querySelectorAll('[contenteditable], textarea, .univer-text-editor, .univer-doc-editor, [class*="text-editor"], [class*="doc-editor"]')).map((el) => ({
      tag: el.tagName,
      cls: typeof el.className === 'string' ? el.className : '',
      visible: el.getBoundingClientRect().width > 0,
    })),
  }));
  console.log('after single click:', JSON.stringify(after1, null, 2));

  // Double click — should enter text-edit mode
  await page.mouse.dblclick(cx, cy);
  await page.waitForTimeout(700);

  const after2 = await page.evaluate(() => ({
    active: document.activeElement?.tagName,
    activeCls: typeof document.activeElement?.className === 'string'
      ? document.activeElement.className.split(' ').slice(0, 3).join(' ')
      : '',
    isContentEditable: !!document.activeElement?.isContentEditable,
    editOverlays: Array.from(document.querySelectorAll('[contenteditable], textarea, .univer-text-editor, .univer-doc-editor, [class*="text-editor"], [class*="doc-editor"]')).map((el) => ({
      tag: el.tagName,
      cls: typeof el.className === 'string' ? el.className : '',
      visible: el.getBoundingClientRect().width > 0,
      x: el.getBoundingClientRect().left,
      y: el.getBoundingClientRect().top,
      w: el.getBoundingClientRect().width,
      h: el.getBoundingClientRect().height,
    })),
  }));
  console.log('after double click:', JSON.stringify(after2, null, 2));

  // Type
  await page.keyboard.type('XYZ', { delay: 60 });
  await page.waitForTimeout(500);

  const after3 = await page.evaluate(() => {
    const w = window;
    const inj = w.univer.__getInjector();
    const inst = inj.get(w.__casualSlides__IUniverInstanceService);
    const model = inst.getCurrentUnitOfType(3);
    return {
      titleText: model.getSnapshot().body.pages['page-1'].pageElements['el-1-title'].richText.text,
      activeAfterType: document.activeElement?.tagName,
      anyEditable: Array.from(document.querySelectorAll('[contenteditable]')).map((el) => ({
        tag: el.tagName,
        text: el.textContent?.slice(0, 50),
      })),
    };
  });
  console.log('after typing XYZ:', JSON.stringify(after3, null, 2));
});
