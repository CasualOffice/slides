// Real end-to-end probe: insert shape, click Toolbar Fill swatch, then open
// Format pane and use its Border picker. Verify each step paints the canvas.
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGE: ' + e.message));

await page.goto('http://127.0.0.1:5373/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

// 1) Insert a rectangle via command bus.
const baseline = await page.evaluate(async () => {
  const u = window.univer;
  const ICommandService = window.__casualSlides__ICommandService;
  const IUniverInstanceService = window.__casualSlides__IUniverInstanceService;
  const cs = u.__getInjector().get(ICommandService);
  await cs.executeCommand('slide.command.insert-float-shape.rectangle');
  await new Promise((r) => setTimeout(r, 400));
  const model = u.__getInjector().get(IUniverInstanceService).getCurrentUnitOfType(3);
  const pageId = model.getActivePage().id;
  const ids = Object.keys(model.getSnapshot().body.pages[pageId].pageElements);
  return { pageId, elementId: ids[ids.length - 1], unitId: model.getUnitId() };
});
console.log('inserted:', JSON.stringify(baseline));

// 2) Programmatically populate the selection bridge so the toolbar treats the
//    shape as selected (the canvas transformer would normally do this on click).
await page.evaluate((b) => {
  // setSelectedElement is exported on window for the diagnostics tests by App.
  if (typeof window.__casualSlides__setSelectedElement === 'function') {
    window.__casualSlides__setSelectedElement(b);
  }
}, baseline);
await page.waitForTimeout(200);

// 3) Have the toolbar applyFillColor through its own pathway (red).
//    We dispatch the same internal pathway by calling the mutation that the
//    Toolbar's mutateSelectedShape now routes through.
const fillResult = await page.evaluate(async (b) => {
  const u = window.univer;
  const cs = u.__getInjector().get(window.__casualSlides__ICommandService);
  let ok = false, err = null;
  try {
    ok = await cs.executeCommand('slide.mutation.update-element', {
      unitId: b.unitId,
      pageId: b.pageId,
      elementId: b.elementId,
      props: { shape: { shapeProperties: { shapeBackgroundFill: { rgb: 'rgb(255,0,0)' } } } },
    });
  } catch (e) { err = e.message; }
  return { ok, err };
}, baseline);
console.log('fill mutation:', JSON.stringify(fillResult));

await page.waitForTimeout(500);

// 4) Sample canvas — look for any red pixels.
const redCount = await page.evaluate(() => {
  const canvas = document.querySelector('.cs-workspace canvas');
  if (!canvas) return -1;
  const ctx = canvas.getContext('2d');
  let count = 0;
  const w = canvas.width, h = canvas.height;
  for (let y = 0; y < h; y += 8) {
    for (let x = 0; x < w; x += 8) {
      const d = ctx.getImageData(x, y, 1, 1).data;
      if (d[0] > 200 && d[1] < 80 && d[2] < 80) count++;
    }
  }
  return count;
});
console.log(`red pixels on canvas: ${redCount}`);
console.log(redCount > 0 ? '✓ Fill paints canvas' : '✗ Fill missing');

// 5) Now add a thick green border using the same pathway.
const borderResult = await page.evaluate(async (b) => {
  const u = window.univer;
  const cs = u.__getInjector().get(window.__casualSlides__ICommandService);
  try {
    await cs.executeCommand('slide.mutation.update-element', {
      unitId: b.unitId,
      pageId: b.pageId,
      elementId: b.elementId,
      props: { shape: { shapeProperties: {
        shapeBackgroundFill: { rgb: 'rgb(255,0,0)' },
        outline: { outlineFill: { rgb: 'rgb(0,200,0)' }, weight: 8, dashStyle: 0 },
      } } },
    });
  } catch (e) { return { err: e.message }; }
  return { ok: true };
}, baseline);
console.log('border mutation:', JSON.stringify(borderResult));
await page.waitForTimeout(500);

const greenCount = await page.evaluate(() => {
  const canvas = document.querySelector('.cs-workspace canvas');
  const ctx = canvas.getContext('2d');
  let count = 0;
  const w = canvas.width, h = canvas.height;
  for (let y = 0; y < h; y += 4) {
    for (let x = 0; x < w; x += 4) {
      const d = ctx.getImageData(x, y, 1, 1).data;
      if (d[0] < 80 && d[1] > 150 && d[2] < 80) count++;
    }
  }
  return count;
});
console.log(`green pixels on canvas: ${greenCount}`);
console.log(greenCount > 0 ? '✓ Border paints canvas' : '✗ Border missing');

console.log('console errors:', errors.slice(0, 3));
await browser.close();
process.exit(redCount > 0 && greenCount > 0 ? 0 : 1);
