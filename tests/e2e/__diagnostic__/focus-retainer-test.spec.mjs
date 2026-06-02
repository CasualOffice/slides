// After Enter inside the editor, manually refocus the editor canvas
// and see if subsequent typing lands inside the editor doc.

import { test } from '@playwright/test';

test('manual refocus after Enter', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  const t = await page.evaluate(() => {
    const w = window;
    const inst = w.univer.__getInjector().get(w.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const pageId = unit.getPageOrder()[0];
    const page = unit.getPage(pageId);
    let title;
    for (const el of Object.values(page.pageElements)) { if (el.id?.includes('title')) { title = el; break; } }
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const main = canvases.reduce((b, x) => !b || x.getBoundingClientRect().width * x.getBoundingClientRect().height >
      b.getBoundingClientRect().width * b.getBoundingClientRect().height ? x : b, null);
    const r = main.getBoundingClientRect();
    const scale = r.width / unit.getPageSize().width;
    return { cx: r.left + (title.left + title.width / 2) * scale, cy: r.top + (title.top + title.height / 2) * scale };
  });

  await page.mouse.dblclick(t.cx, t.cy);
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(150);
  await page.keyboard.type('A', { delay: 30 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  // Manual refocus — find the editor's render canvas (it should be inside the [univer-z-10] container)
  const refocusInfo = await page.evaluate(() => {
    const editorContainer = document.querySelector('[univer-z-10]') || document.querySelector('[data-u-comp="editor-container"]');
    if (!editorContainer) return { found: false };
    const innerCanvas = editorContainer.querySelector('canvas');
    if (!innerCanvas) return { found: true, hasCanvas: false, html: editorContainer.outerHTML.slice(0, 400) };
    innerCanvas.focus();
    return { found: true, hasCanvas: true, focused: document.activeElement === innerCanvas };
  });
  console.log('refocus:', refocusInfo);
  await page.keyboard.type('B', { delay: 30 });
  await page.waitForTimeout(400);

  const focus2 = await page.evaluate(() => document.activeElement?.tagName + '/' + (document.activeElement?.getAttribute && document.activeElement.getAttribute('data-u-comp')));
  console.log('after refocus + B:', focus2);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  const final = await page.evaluate(() => {
    const w = window;
    const inst = w.univer.__getInjector().get(w.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const snap = unit.getSnapshot();
    const pageId = snap.body.pageOrder[0];
    const page = snap.body.pages[pageId];
    let title; for (const el of Object.values(page.pageElements)) { if (el.id?.includes('title')) { title = el; break; } }
    return { text: title.richText.text, dataStream: title.richText.rich?.body?.dataStream };
  });
  console.log('FINAL:', JSON.stringify(final));
});
