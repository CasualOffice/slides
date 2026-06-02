// Verify Shift+click adds to the canvas selection (multi-select).
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://127.0.0.1:5373/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

// Insert two rectangles at distinct positions.
await page.evaluate(async () => {
  const u = window.univer;
  const cs = u.__getInjector().get(window.__casualSlides__ICommandService);
  await cs.executeCommand('slide.command.insert-float-shape.rectangle');
  await new Promise((r) => setTimeout(r, 300));
  await cs.executeCommand('slide.command.insert-float-shape.rectangle');
});
await page.waitForTimeout(800);

const info = await page.evaluate(() => {
  const m = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService).getCurrentUnitOfType(3);
  const pageId = m.getActivePage().id;
  const els = Object.entries(m.getSnapshot().body.pages[pageId].pageElements);
  const rects = els.filter(([, v]) => v.shape).slice(-2);
  // Move the second so they don't overlap.
  if (rects.length >= 2) {
    rects[1][1].left = (rects[0][1].left ?? 100) + 280;
    rects[1][1].top = rects[0][1].top;
    m.incrementRev();
    m.setActivePage(m.getActivePage());
  }
  const canvases = Array.from(document.querySelectorAll('canvas'));
  const main = canvases.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  const r = main.getBoundingClientRect();
  return {
    rects: rects.map(([id, v]) => ({ id, left: v.left, top: v.top, width: v.width, height: v.height })),
    canvas: { x: r.x, y: r.y, w: r.width, h: r.height },
  };
});
console.log('rects:', JSON.stringify(info.rects));
if (info.rects.length < 2) { console.log('not enough rects'); await browser.close(); process.exit(1); }

const SCENE_W = 1500, SCENE_H = 843;
const r1 = info.rects[0], r2 = info.rects[1];
const c1x = info.canvas.x + (r1.left + r1.width / 2) * (info.canvas.w / SCENE_W);
const c1y = info.canvas.y + (r1.top + r1.height / 2) * (info.canvas.h / SCENE_H);
const c2x = info.canvas.x + (r2.left + r2.width / 2) * (info.canvas.w / SCENE_W);
const c2y = info.canvas.y + (r2.top + r2.height / 2) * (info.canvas.h / SCENE_H);
console.log('click 1 at:', c1x.toFixed(0), c1y.toFixed(0));
console.log('click 2 at:', c2x.toFixed(0), c2y.toFixed(0));

// Click rect 1.
await page.mouse.click(c1x, c1y);
await page.waitForTimeout(400);

const selAfter1 = await page.evaluate(() => {
  // Walk every render unit looking for transformer's selectedObjectMap.
  const u = window.univer;
  const inj = u.__getInjector();
  const rm = inj.get(window.__casualSlides__IRenderManagerService);
  const all = Array.from(rm.getRenderAll().values());
  let total = 0;
  for (const r of all) {
    const t = r.scene?.getTransformer?.();
    if (t) total += t.getSelectedObjectMap?.()?.size ?? 0;
  }
  return total;
});
console.log('after 1 click — selected count:', selAfter1);

// Shift+click rect 2.
await page.keyboard.down('Shift');
await page.mouse.click(c2x, c2y);
await page.keyboard.up('Shift');
await page.waitForTimeout(400);

const selAfter2 = await page.evaluate(() => {
  const u = window.univer;
  const inj = u.__getInjector();
  const rm = inj.get(window.__casualSlides__IRenderManagerService);
  const all = Array.from(rm.getRenderAll().values());
  let total = 0;
  for (const r of all) {
    const t = r.scene?.getTransformer?.();
    if (t) total += t.getSelectedObjectMap?.()?.size ?? 0;
  }
  return total;
});
console.log('after Shift+click — selected count:', selAfter2);
console.log(selAfter2 >= 2 ? '✓ Shift+click adds to selection' : '✗ Shift+click cleared selection (patch not loaded)');
console.log('errors:', errors.slice(0, 3));
await browser.close();
process.exit(selAfter2 >= 2 ? 0 : 1);
