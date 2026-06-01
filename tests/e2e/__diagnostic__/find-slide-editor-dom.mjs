// Find the SlideEditorContainer div in the DOM and inspect.
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:5373/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

await page.evaluate(async () => {
  const u = window.univer;
  const cs = u.__getInjector().get(window.__casualSlides__ICommandService);
  await cs.executeCommand('slide.command.add-text');
});
await page.waitForTimeout(500);

// Find element + position click.
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
await page.waitForTimeout(150);
await page.mouse.dblclick(cx, cy);
await page.waitForTimeout(500);

// Now snapshot all divs at canvas region with z-index.
const editorInfo = await page.evaluate(() => {
  // Walk all positioned divs and inspect.
  const out = [];
  document.querySelectorAll('div').forEach((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.position === 'absolute' || cs.position === 'fixed') {
      if (r.width || r.height) {
        out.push({
          cls: el.className.slice(0, 80),
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          z: cs.zIndex,
        });
      }
    }
  });
  return out.slice(0, 30);
});
console.log('absolute divs:', JSON.stringify(editorInfo, null, 2));

await browser.close();
