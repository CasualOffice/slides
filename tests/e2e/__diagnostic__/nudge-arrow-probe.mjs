// Verify ArrowRight nudges the selected element by 1px (10px with Shift).
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://127.0.0.1:5373/', { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);

// Pre-click the canvas centre once — this ensures Univer's per-page render
// unit + transformer are fully wired before we subscribe via FormatPane.
await page.mouse.click(720, 450);
await page.waitForTimeout(400);
await page.mouse.click(50, 50);  // click outside to clear
await page.waitForTimeout(400);

await page.evaluate(async () => {
  const u = window.univer;
  const cs = u.__getInjector().get(window.__casualSlides__ICommandService);
  await cs.executeCommand('slide.command.add-text');
});
await page.waitForTimeout(1200);

const baseline = await page.evaluate(() => {
  const model = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService).getCurrentUnitOfType(3);
  const pageId = model.getActivePage().id;
  const els = model.getSnapshot().body.pages[pageId].pageElements;
  let id = null, el = null;
  for (const [k, v] of Object.entries(els)) {
    if (v.type === 2 || v.richText) { id = k; el = v; }
  }
  const canvases = Array.from(document.querySelectorAll('canvas'));
  const main = canvases.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  const r = main.getBoundingClientRect();
  return { pageId, id, left: el.left, top: el.top, snap: el, canvas: { x: r.x, y: r.y, w: r.width, h: r.height } };
});
console.log('baseline:', JSON.stringify({ pageId: baseline.pageId, id: baseline.id, left: baseline.left, top: baseline.top }));

// Click the text element on the canvas to populate the selection bridge
// the real way (transformer.createControl$).
const SCENE_W = 1500, SCENE_H = 843;
const cx = baseline.canvas.x + (baseline.snap.left + baseline.snap.width / 2) * (baseline.canvas.w / SCENE_W);
const cy = baseline.canvas.y + (baseline.snap.top + baseline.snap.height / 2) * (baseline.canvas.h / SCENE_H);
// Click twice with a wait — second click may help the transformer populate.
await page.mouse.click(cx, cy);
await page.waitForTimeout(400);
await page.mouse.click(cx, cy);
await page.waitForTimeout(400);

// Inspect whether anything is in the slide rail's selected indicator OR
// whether the FormatPane appeared (proxy for selection bridge populated).
const selDbg = await page.evaluate(() => {
  const formatPane = document.querySelector('.cs-format-pane, [aria-label*="Format"]');
  const transformerControls = document.querySelectorAll('canvas').length;
  return { hasFormatPane: !!formatPane, canvasCount: transformerControls };
});
console.log('selection debug:', JSON.stringify(selDbg));

const selFromBridge = await page.evaluate(() => {
  return window.__getSelectedElement ? window.__getSelectedElement() : 'no getter exposed';
});
console.log('getSelectedElement returns:', JSON.stringify(selFromBridge));

// Intercept keydown to verify it reaches window.
await page.evaluate(() => {
  window.__keyTrace = [];
  window.addEventListener('keydown', (e) => {
    window.__keyTrace.push({ key: e.key, target: e.target?.tagName, prevented: e.defaultPrevented });
  }, true);
});

// Focus body so arrow keys go to window keydown.
await page.evaluate(() => document.body.focus());

await page.keyboard.press('ArrowRight');
await page.waitForTimeout(150);
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(150);

const afterTwoArrows = await page.evaluate((b) => {
  const m = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService).getCurrentUnitOfType(3);
  const el = m.getSnapshot().body.pages[b.pageId].pageElements[b.id];
  return { left: el.left, top: el.top };
}, baseline);
console.log('after 2× ArrowRight (expect +2 to left):', JSON.stringify(afterTwoArrows));

// Shift+ArrowDown — nudge 10px down.
await page.keyboard.down('Shift');
await page.keyboard.press('ArrowDown');
await page.keyboard.up('Shift');
await page.waitForTimeout(150);

const afterShiftDown = await page.evaluate((b) => {
  const m = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService).getCurrentUnitOfType(3);
  const el = m.getSnapshot().body.pages[b.pageId].pageElements[b.id];
  return { left: el.left, top: el.top };
}, baseline);
console.log('after Shift+ArrowDown (expect +10 to top):', JSON.stringify(afterShiftDown));

const arrowOk = afterTwoArrows.left === baseline.left + 2 && afterTwoArrows.top === baseline.top;
const shiftOk = afterShiftDown.top === baseline.top + 10;
// Also directly dispatch the update-element operation to see if it works
// at all.
const directResult = await page.evaluate(async (b) => {
  const u = window.univer;
  const cs = u.__getInjector().get(window.__casualSlides__ICommandService);
  const m = u.__getInjector().get(window.__casualSlides__IUniverInstanceService).getCurrentUnitOfType(3);
  let ok = false, err = null;
  try {
    ok = await cs.executeCommand('slide.operation.update-element', {
      unitId: m.getUnitId(),
      oKey: b.id,
      props: { left: b.left + 50 },
    });
  } catch (e) { err = e.message; }
  const el = m.getSnapshot().body.pages[b.pageId].pageElements[b.id];
  return { ok, err, left: el.left, top: el.top };
}, baseline);
console.log('direct update-element result:', JSON.stringify(directResult));

const trace = await page.evaluate(() => window.__keyTrace ?? []);
console.log('key trace:', JSON.stringify(trace));
const dump = await page.evaluate(() => ({
  fired: window.__nudgeFired ?? 0,
  trace: window.__nudgeTrace ?? null,
  sel: window.__nudgeSel ?? null,
}));
console.log('nudge trace:', JSON.stringify(dump, null, 2));
console.log(arrowOk ? '✓ ArrowRight nudges +1' : '✗ ArrowRight nudge failed');
console.log(shiftOk ? '✓ Shift+ArrowDown nudges +10' : '✗ Shift+arrow nudge failed');
console.log('errors:', errors.slice(0, 3));
await browser.close();
process.exit(arrowOk && shiftOk ? 0 : 1);
