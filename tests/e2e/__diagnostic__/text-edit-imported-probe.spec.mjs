// Does text-edit work on an IMPORTED pptx? If yes → bug is in our
// synthetic default deck (likely my placeholder content). If no → engine.

import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('text-edit on imported pptx', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => console.log(`[b ${m.type()}] ${m.text()}`));

  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2000);

  // Import a real pptx
  const buf = readFileSync(path.resolve(__dirname, '../fixtures/your-big-idea.pptx'));
  await page.locator('input[type="file"]').setInputFiles({
    name: 'your-big-idea.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer: buf,
  });
  await page.waitForFunction(() => (document.querySelector('.cs-titlebar__pill--status'))?.innerText?.includes('Loaded'), null, { timeout: 60_000 }).catch(()=>{});
  await page.waitForTimeout(2500);

  // Find the FIRST text element on the active slide
  const target = await page.evaluate(() => {
    const w = window;
    const inj = w.univer.__getInjector();
    const inst = inj.get(w.__casualSlides__IUniverInstanceService);
    const model = inst.getCurrentUnitOfType(3);
    const snap = model.getSnapshot();
    const activeId = model.getActivePage()?.id ?? snap.body.pageOrder[0];
    const page = snap.body.pages[activeId];
    const textEl = Object.values(page.pageElements).find((e) => e.richText?.text);
    if (!textEl) return null;
    // Compute screen coords for centre of the element
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const c = canvases.reduce((b, x) => !b || x.getBoundingClientRect().width * x.getBoundingClientRect().height >
      b.getBoundingClientRect().width * b.getBoundingClientRect().height ? x : b, null);
    const r = c.getBoundingClientRect();
    const renderMgr = inj.get(w.__casualSlides__IRenderManagerService);
    const ru = renderMgr.getRenderById(model.getUnitId());
    const scale = ru.scene.getScale?.() ?? { x: 1, y: 1 };
    const sw = snap.pageSize.width * scale.x, sh = snap.pageSize.height * scale.y;
    const oX = (r.width - sw) / 2, oY = (r.height - sh) / 2;
    return {
      elId: textEl.id,
      origText: textEl.richText?.text,
      cx: r.left + oX + (textEl.left + textEl.width / 2) * scale.x,
      cy: r.top + oY + (textEl.top + textEl.height / 2) * scale.y,
    };
  });
  console.log('target:', JSON.stringify(target));
  if (!target) { console.log('NO TEXT ELEMENT FOUND'); return; }

  // dblclick + type
  await page.mouse.click(target.cx, target.cy);
  await page.waitForTimeout(300);
  await page.mouse.dblclick(target.cx, target.cy);
  await page.waitForTimeout(700);

  // Where's the contenteditable now?
  const overlay = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[contenteditable]')).map((e) => {
      const r = e.getBoundingClientRect();
      return { tag: e.tagName, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), focused: document.activeElement === e };
    });
  });
  console.log('overlays after dblclick:', JSON.stringify(overlay));

  await page.keyboard.type('PROBE-EDIT', { delay: 50 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  const after = await page.evaluate((id) => {
    const w = window;
    const inj = w.univer.__getInjector();
    const inst = inj.get(w.__casualSlides__IUniverInstanceService);
    const model = inst.getCurrentUnitOfType(3);
    const snap = model.getSnapshot();
    const pageId = model.getActivePage()?.id ?? snap.body.pageOrder[0];
    return snap.body.pages[pageId].pageElements[id]?.richText?.text;
  }, target.elId);
  console.log(`text was: "${target.origText}"`);
  console.log(`text now: "${after}"`);
  console.log(after && after !== target.origText && after.includes('PROBE') ? '✓ TEXT EDIT WORKED ON IMPORTED PPTX' : '❌ TEXT EDIT STILL BROKEN ON IMPORTED PPTX');
});
