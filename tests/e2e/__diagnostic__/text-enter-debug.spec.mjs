// Snapshot the editor's doc unit data BEFORE Escape, so we can see
// whether Enter is creating a paragraph in the editor at all.

import { test } from '@playwright/test';

test('check editor doc state mid-edit after Enter', async ({ page }) => {
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
    for (const el of Object.values(page.pageElements)) {
      if (el.id?.includes('title')) { title = el; break; }
    }
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const main = canvases.reduce((b, x) => !b || x.getBoundingClientRect().width * x.getBoundingClientRect().height >
      b.getBoundingClientRect().width * b.getBoundingClientRect().height ? x : b, null);
    const r = main.getBoundingClientRect();
    const scale = r.width / unit.getPageSize().width;
    return {
      cx: r.left + (title.left + title.width / 2) * scale,
      cy: r.top + (title.top + title.height / 2) * scale,
    };
  });

  await page.mouse.dblclick(t.cx, t.cy);
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(150);
  await page.keyboard.type('A', { delay: 30 });
  await page.waitForTimeout(300);
  console.log('after A:', await page.evaluate(() => document.activeElement?.tagName + '/' + (document.activeElement?.getAttribute && document.activeElement.getAttribute('data-u-comp'))));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  console.log('after Enter:', await page.evaluate(() => document.activeElement?.tagName + '/' + (document.activeElement?.getAttribute && document.activeElement.getAttribute('data-u-comp'))));
  await page.keyboard.type('B', { delay: 30 });
  await page.waitForTimeout(500);
  console.log('after B:', await page.evaluate(() => document.activeElement?.tagName + '/' + (document.activeElement?.getAttribute && document.activeElement.getAttribute('data-u-comp'))));

  // Dump the editor doc model BEFORE Escape
  const editorDoc = await page.evaluate(() => {
    const w = window;
    const inj = w.univer.__getInjector();
    const inst = inj.get(w.__casualSlides__IUniverInstanceService);
    const allUnits = [];
    // Walk all unit ids
    try {
      const ids = inst.getAllUnitsForType?.(0) || [];
      for (const u of ids) allUnits.push({ id: u.getUnitId?.(), type: 'DOC' });
    } catch {}
    // The slide editor unit lives at SLIDE_EDITOR_ID = '__INTERNAL_EDITOR__SLIDE_EDITOR'
    const editorUnit = inst.getUnit('__INTERNAL_EDITOR__SLIDE_EDITOR');
    if (editorUnit) {
      const data = editorUnit.getSnapshot?.() || editorUnit.getData?.();
      return { id: editorUnit.getUnitId?.(), snapshot: data };
    }
    return { allUnits, found: null };
  });
  console.log('EDITOR DOC MID-EDIT:', JSON.stringify(editorDoc, null, 2));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  const final = await page.evaluate(() => {
    const w = window;
    const inst = w.univer.__getInjector().get(w.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const snap = unit.getSnapshot();
    const pageId = snap.body.pageOrder[0];
    const page = snap.body.pages[pageId];
    let title;
    for (const el of Object.values(page.pageElements)) {
      if (el.id?.includes('title')) { title = el; break; }
    }
    return title.richText;
  });
  console.log('SLIDE MODEL FINAL:', JSON.stringify(final, null, 2));
});
