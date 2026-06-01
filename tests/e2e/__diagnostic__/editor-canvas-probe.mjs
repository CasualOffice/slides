// Verify the RichTextEditor's own canvas exists inside SlideEditorContainer
// and that mouse drag on IT produces a selection state.
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
page.on('pageerror', (e) => errors.push('PAGE: ' + e.message));

await page.goto('http://127.0.0.1:5373/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3500);

await page.evaluate(async () => {
  const u = window.univer;
  const cs = u.__getInjector().get(window.__casualSlides__ICommandService);
  await cs.executeCommand('slide.command.add-text');
});
await page.waitForTimeout(800);

// Locate.
const info = await page.evaluate(() => {
  const model = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService).getCurrentUnitOfType(3);
  const pageId = model.getActivePage().id;
  const els = model.getSnapshot().body.pages[pageId].pageElements;
  let el = null;
  for (const v of Object.values(els)) if (v.type === 2 || v.richText) el = v;
  const canvases = Array.from(document.querySelectorAll('canvas'));
  const main = canvases.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  const r = main.getBoundingClientRect();
  return { snap: el, canvas: { x: r.x, y: r.y, w: r.width, h: r.height }, canvasCount: canvases.length };
});

const SCENE_W = 1500, SCENE_H = 843;
const cx = info.canvas.x + (info.snap.left + info.snap.width / 2) * (info.canvas.w / SCENE_W);
const cy = info.canvas.y + (info.snap.top + info.snap.height / 2) * (info.canvas.h / SCENE_H);
console.log('canvases pre-dblclick:', info.canvasCount, 'target click at:', cx.toFixed(0), cy.toFixed(0));

// Single click to select, then double-click to enter edit.
await page.mouse.click(cx, cy);
await page.waitForTimeout(200);
await page.mouse.dblclick(cx, cy);
await page.waitForTimeout(700);

// Re-enumerate canvases — the editor should have added one.
const after = await page.evaluate(() => {
  const canvases = Array.from(document.querySelectorAll('canvas')).map((c, i) => {
    const r = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    return {
      i,
      x: r.x, y: r.y, w: r.width, h: r.height,
      style: { position: cs.position, zIndex: cs.zIndex, pointer: cs.pointerEvents, visibility: cs.visibility },
      parentCls: c.parentElement?.className?.slice(0, 60) || c.parentElement?.tagName,
    };
  });
  // Find the floating editor container div.
  const containers = Array.from(document.querySelectorAll('div.univer-absolute.univer-z-10')).map((d) => {
    const r = d.getBoundingClientRect();
    return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, childCount: d.children.length, innerHTMLLen: d.innerHTML.length };
  });
  return { canvases, containers };
});
console.log('canvases after dblclick:', JSON.stringify(after, null, 2));
console.log('errors:', errors.slice(0, 5));

await browser.close();
