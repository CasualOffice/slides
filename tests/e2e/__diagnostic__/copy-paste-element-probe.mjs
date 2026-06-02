// Verify element copy/paste + duplicate-element works.
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://127.0.0.1:5373/', { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);

await page.evaluate(async () => {
  const u = window.univer;
  const cs = u.__getInjector().get(window.__casualSlides__ICommandService);
  await cs.executeCommand('slide.command.insert-float-shape.rectangle');
});
await page.waitForTimeout(800);

const beforeCount = await page.evaluate(() => {
  const m = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService).getCurrentUnitOfType(3);
  const pageId = m.getActivePage().id;
  return { pageId, count: Object.keys(m.getSnapshot().body.pages[pageId].pageElements).length };
});
console.log('before count:', beforeCount.count);

// Directly invoke duplicate-element + paste-element via dispatchSlideCommand
// path — bypasses needing selection bridge populated via click.
const result = await page.evaluate(async () => {
  // Manually populate selection bridge by triggering a click on the
  // last-inserted element. The bridge is exported by the module but
  // not on window — easiest path: import via dynamic ESM. Try via the
  // selection.ts module path used internally.
  const ICommandService = window.__casualSlides__ICommandService;
  const IUniverInstanceService = window.__casualSlides__IUniverInstanceService;
  const u = window.univer;
  const m = u.__getInjector().get(IUniverInstanceService).getCurrentUnitOfType(3);
  const pageId = m.getActivePage().id;
  const ids = Object.keys(m.getSnapshot().body.pages[pageId].pageElements);
  const newest = ids[ids.length - 1];

  // Click the element at its canvas position to populate bridge.
  const el = m.getSnapshot().body.pages[pageId].pageElements[newest];
  const canvases = Array.from(document.querySelectorAll('canvas'));
  const main = canvases.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  const r = main.getBoundingClientRect();
  const SCENE_W = 1500, SCENE_H = 843;
  const cx = r.x + (el.left + el.width / 2) * (r.w ?? r.width) / SCENE_W;
  const cy = r.y + (el.top + el.height / 2) * (r.h ?? r.height) / SCENE_H;
  // Dispatch via pointer events on the canvas to trigger transformer
  const pointerDown = new PointerEvent('pointerdown', {
    pointerType: 'mouse', clientX: cx, clientY: cy, button: 0, bubbles: true,
  });
  const pointerUp = new PointerEvent('pointerup', {
    pointerType: 'mouse', clientX: cx, clientY: cy, button: 0, bubbles: true,
  });
  main.dispatchEvent(pointerDown);
  main.dispatchEvent(pointerUp);
  await new Promise((r) => setTimeout(r, 300));

  return { newest, cx, cy };
});
console.log('clicked:', JSON.stringify(result));

// Now simulate Ctrl+D (duplicate element) and check the count.
await page.keyboard.press('Control+d');
await page.waitForTimeout(400);

const afterDup = await page.evaluate(() => {
  const m = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService).getCurrentUnitOfType(3);
  const pageId = m.getActivePage().id;
  return { count: Object.keys(m.getSnapshot().body.pages[pageId].pageElements).length };
});
console.log('after Ctrl+D:', afterDup.count, afterDup.count === beforeCount.count + 1 ? '✓ duplicated' : '✗ no dup');

// Ctrl+C then Ctrl+V → another copy.
await page.keyboard.press('Control+c');
await page.waitForTimeout(150);
await page.keyboard.press('Control+v');
await page.waitForTimeout(400);

const afterPaste = await page.evaluate(() => {
  const m = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService).getCurrentUnitOfType(3);
  const pageId = m.getActivePage().id;
  return { count: Object.keys(m.getSnapshot().body.pages[pageId].pageElements).length };
});
console.log('after Ctrl+C+V:', afterPaste.count, afterPaste.count > afterDup.count ? '✓ pasted' : '✗ no paste');

// Direct dispatch test (bypassing selection bridge / keyboard) — verifies
// the underlying nudge command path works.
const directDup = await page.evaluate(async () => {
  // Manually populate the in-memory element clipboard by importing the
  // commands module. Since we can't easily reach the module, the cleanest
  // path is to verify via dispatchSlideCommand with selection populated.
  // FormatPane subscribes lazily, so we wait then dispatch.
  await new Promise((r) => setTimeout(r, 500));
  // Read snapshot just to confirm we can.
  const m = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService).getCurrentUnitOfType(3);
  const pageId = m.getActivePage().id;
  return { count: Object.keys(m.getSnapshot().body.pages[pageId].pageElements).length };
});
console.log('after wait:', directDup.count);

console.log('errors:', errors.slice(0, 3));
await browser.close();
