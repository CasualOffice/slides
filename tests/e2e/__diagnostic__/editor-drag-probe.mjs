// Once the editor canvas is up, drag INSIDE the editor canvas (not over the
// slide canvas position) and check whether text selection lands.
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });

await page.goto('http://127.0.0.1:5373/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

await page.evaluate(async () => {
  const u = window.univer;
  const cs = u.__getInjector().get(window.__casualSlides__ICommandService);
  await cs.executeCommand('slide.command.add-text');
});
await page.waitForTimeout(800);

// click + dblclick on the text element
const info = await page.evaluate(() => {
  const model = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService).getCurrentUnitOfType(3);
  const pageId = model.getActivePage().id;
  const els = model.getSnapshot().body.pages[pageId].pageElements;
  let el = null;
  for (const v of Object.values(els)) if (v.type === 2 || v.richText) el = v;
  const canvases = Array.from(document.querySelectorAll('canvas'));
  const main = canvases.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  const r = main.getBoundingClientRect();
  return { snap: el, canvas: { x: r.x, y: r.y, w: r.width, h: r.height } };
});
const SCENE_W = 1500, SCENE_H = 843;
const cx = info.canvas.x + (info.snap.left + info.snap.width / 2) * (info.canvas.w / SCENE_W);
const cy = info.canvas.y + (info.snap.top + info.snap.height / 2) * (info.canvas.h / SCENE_H);

await page.mouse.click(cx, cy);
await page.waitForTimeout(200);
await page.mouse.dblclick(cx, cy);
await page.waitForTimeout(700);

// Find the editor canvas (the smallest visible canvas that just appeared).
const editorCanvas = await page.evaluate(() => {
  const all = Array.from(document.querySelectorAll('canvas'));
  let editor = null;
  for (const c of all) {
    const r = c.getBoundingClientRect();
    if (r.width > 50 && r.width < 600 && r.height < 100 && c.parentElement?.className?.includes('univer-size-full')) {
      editor = { x: r.x, y: r.y, w: r.width, h: r.height };
    }
  }
  return editor;
});
console.log('editor canvas:', JSON.stringify(editorCanvas));
if (!editorCanvas) { console.log('✗ no editor canvas'); await browser.close(); process.exit(1); }

// Take a before-drag screenshot of just the editor area.
await page.screenshot({
  path: '/tmp/editor-before.png',
  clip: { x: editorCanvas.x - 30, y: editorCanvas.y - 20, width: editorCanvas.w + 60, height: editorCanvas.h + 40 },
});

// Drag inside the editor canvas.
const dragY = editorCanvas.y + editorCanvas.h / 2;
const dragStartX = editorCanvas.x + 20;
const dragEndX = editorCanvas.x + editorCanvas.w - 20;
await page.mouse.move(dragStartX, dragY);
await page.mouse.down();
for (let s = 1; s <= 6; s++) {
  const t = s / 6;
  await page.mouse.move(dragStartX + (dragEndX - dragStartX) * t, dragY);
  await page.waitForTimeout(40);
}
await page.mouse.up();
await page.waitForTimeout(500);

await page.screenshot({
  path: '/tmp/editor-after.png',
  clip: { x: editorCanvas.x - 30, y: editorCanvas.y - 20, width: editorCanvas.w + 60, height: editorCanvas.h + 40 },
});

// Sample editor canvas pixels for selection-highlight blues.
const blueish = await page.evaluate((e) => {
  const c = Array.from(document.querySelectorAll('canvas'))
    .find((x) => {
      const r = x.getBoundingClientRect();
      return Math.abs(r.x - e.x) < 1 && Math.abs(r.y - e.y) < 1;
    });
  if (!c) return -1;
  const ctx = c.getContext('2d');
  let count = 0;
  for (let y = 0; y < c.height; y += 2) {
    for (let x = 0; x < c.width; x += 2) {
      const d = ctx.getImageData(x, y, 1, 1).data;
      // any blueish (selection highlight is usually rgba(0, 127, 255, ~0.3) over white)
      if (d[2] > 200 && d[2] - Math.max(d[0], d[1]) > 30) count++;
    }
  }
  return count;
}, editorCanvas);
console.log('blueish pixels in editor canvas:', blueish);
console.log(blueish > 5 ? '✓ selection highlight visible' : '✗ no selection highlight detected');
console.log('errors:', errors.slice(0, 5));
await browser.close();
