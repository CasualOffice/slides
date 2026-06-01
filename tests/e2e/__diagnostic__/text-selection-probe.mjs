// Reproduce the user's complaint: "can't select text in box in canvas".
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGE: ' + e.message));

await page.goto('http://127.0.0.1:5373/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

// Insert a text element.
await page.evaluate(async () => {
  const u = window.univer;
  const cs = u.__getInjector().get(window.__casualSlides__ICommandService);
  await cs.executeCommand('slide.command.add-text');
});
await page.waitForTimeout(800);

// Find element position on the page.
const info = await page.evaluate(() => {
  const u = window.univer;
  const model = u.__getInjector().get(window.__casualSlides__IUniverInstanceService).getCurrentUnitOfType(3);
  const pageId = model.getActivePage().id;
  const els = model.getSnapshot().body.pages[pageId].pageElements;
  let id = null, el = null;
  for (const [k, v] of Object.entries(els)) {
    if (v.type === 2 || v.richText) { id = k; el = v; }
  }
  // Enumerate all canvases — Univer puts the main slide canvas in the
  // .cs-workspace area but there are smaller canvases for the slide rail
  // thumbnails.
  const canvases = Array.from(document.querySelectorAll('canvas')).map((c, i) => {
    const r = c.getBoundingClientRect();
    return { i, w: r.width, h: r.height, x: r.x, y: r.y, internalW: c.width, internalH: c.height, parent: c.parentElement?.className || c.parentElement?.tagName };
  });
  return {
    id,
    snapshotPos: { left: el?.left, top: el?.top, width: el?.width, height: el?.height },
    canvases,
    text: el?.richText?.rich?.body?.dataStream ?? el?.richText?.text,
  };
});
console.log('text element + canvas:', JSON.stringify(info, null, 2));

// Pick the biggest canvas — that's the main slide canvas.
const main = info.canvases.sort((a, b) => b.w * b.h - a.w * a.h)[0];
if (!main) { console.log('no canvas'); await browser.close(); process.exit(1); }
console.log('main canvas:', JSON.stringify(main));

// Map slide coords → on-screen. Standard Univer slide scene is 1500x843.
const SCENE_W = 1500, SCENE_H = 843;
const scaleX = main.w / SCENE_W, scaleY = main.h / SCENE_H;
const elCenterX = (info.snapshotPos.left + info.snapshotPos.width / 2);
const elCenterY = (info.snapshotPos.top + info.snapshotPos.height / 2);
const cx = main.x + elCenterX * scaleX;
const cy = main.y + elCenterY * scaleY;
console.log(`text element centre on-screen at (${cx.toFixed(0)},${cy.toFixed(0)})`);

// 1. Click once on the text — selects (transformer handles).
await page.mouse.click(cx, cy);
await page.waitForTimeout(400);
const afterClick = await page.evaluate(() => ({
  selectedElementBridge: window.__casualSlides__selectedElement ?? null,
  // try to detect the transformer handles dom marker
  hasControls: !!document.querySelector('[data-component-name="control-skin"]')
    || !!document.querySelector('.univer-skin-style-canvas'),
}));
console.log('after single click:', JSON.stringify(afterClick));

// 2. Double-click on the text — enters edit mode (Univer's slide-editor-bridge).
await page.mouse.dblclick(cx, cy);
await page.waitForTimeout(500);
const afterDbl = await page.evaluate(() => {
  const docUnits = window.univer
    ?.__getInjector()
    ?.get(window.__casualSlides__IUniverInstanceService)
    ?.getCurrentUnitOfType(1);
  return {
    docPresent: !!docUnits,
    docId: docUnits?.getUnitId?.() ?? null,
    activeElement: document.activeElement?.tagName + '#' + document.activeElement?.id,
  };
});
console.log('after double click:', JSON.stringify(afterDbl));

// 3. Try to drag-select text by mousedown → move → mouseup horizontally.
await page.screenshot({ path: '/tmp/before-drag.png', clip: { x: main.x, y: main.y, width: main.w, height: main.h }});
await page.mouse.move(cx - 80, cy);
await page.mouse.down();
await page.mouse.move(cx - 40, cy, { steps: 4 });
await page.mouse.move(cx, cy, { steps: 4 });
await page.mouse.move(cx + 40, cy, { steps: 4 });
await page.mouse.up();
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/after-drag.png', clip: { x: main.x, y: main.y, width: main.w, height: main.h }});
console.log('screenshots saved /tmp/before-drag.png /tmp/after-drag.png');

// 5. Look for selection-highlight rectangles drawn on canvas — typically
//    rgb(33,150,243) or rgb(0,127,255) Univer text-selection blue. Count
//    blueish non-bg pixels in the slice.
const blueCount = await page.evaluate((m) => {
  const canvas = document.querySelectorAll('canvas')[1];
  const ctx = canvas.getContext('2d');
  let count = 0;
  for (let y = 0; y < canvas.height; y += 2) {
    for (let x = 0; x < canvas.width; x += 2) {
      const d = ctx.getImageData(x, y, 1, 1).data;
      // any "selection blue" with translucent overlay
      if (d[2] > 180 && d[0] < 150 && d[1] < 200) count++;
    }
  }
  return count;
}, main);
console.log('blueish (selection-highlight) pixels on main canvas:', blueCount);

// 4. Inspect whether Univer's doc has a non-empty text range selection.
const dragResult = await page.evaluate(() => {
  const u = window.univer;
  if (!u) return { err: 'no univer' };
  try {
    // Univer's text selection lives in DocSelectionManagerService /
    // TextSelectionManagerService — look it up via injector by trying a
    // few common token names.
    const inj = u.__getInjector();
    // The injector exposes named tokens via get(name) when registered with
    // a string identifier; we can't enumerate without the IIdentifier set.
    // Best we can do: read the focused unit + its docState if any.
    const inst = inj.get(window.__casualSlides__IUniverInstanceService);
    const doc = inst.getCurrentUnitOfType(1);
    if (!doc) return { docFocused: false };
    const snap = doc.getSnapshot?.();
    return {
      docFocused: true,
      docTextLen: snap?.body?.dataStream?.length ?? null,
    };
  } catch (e) { return { err: e.message }; }
});
console.log('drag result:', JSON.stringify(dragResult));

console.log('errors:', errors.slice(0, 5));
await browser.close();
