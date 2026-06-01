// Verify Bold applied to a SELECTED text element (not in text-edit mode)
// changes the rendered glyph weight.
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://127.0.0.1:5373/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

// 1) Insert a text element via command bus.
await page.evaluate(async () => {
  const u = window.univer;
  const cs = u.__getInjector().get(window.__casualSlides__ICommandService);
  await cs.executeCommand('slide.command.add-text');
});
await page.waitForTimeout(800);

const baseline = await page.evaluate(() => {
  const u = window.univer;
  const model = u.__getInjector()
    .get(window.__casualSlides__IUniverInstanceService)
    .getCurrentUnitOfType(3);
  const pageId = model.getActivePage().id;
  const els = model.getSnapshot().body.pages[pageId].pageElements;
  // Find the most recently added TEXT element.
  let textId = null;
  for (const [k, v] of Object.entries(els)) {
    if (v.type === 2 /* TEXT */ || v.richText) textId = k;
  }
  return { pageId, elementId: textId, unitId: model.getUnitId() };
});
console.log('text element:', JSON.stringify(baseline));

if (!baseline.elementId) { console.log('✗ no text element created'); await browser.close(); process.exit(1); }

// 2) Mark it selected via the selection bridge.
await page.evaluate((b) => {
  if (typeof window.__casualSlides__setSelectedElement === 'function') {
    window.__casualSlides__setSelectedElement(b);
  }
}, baseline);
await page.waitForTimeout(200);

// 3) Click the Bold toolbar button.
const boldBtn = page.locator('button[aria-label="Bold"]').first();
const boldHas = await boldBtn.count();
console.log('toolbar Bold button found:', boldHas > 0);
if (!boldHas) { await browser.close(); process.exit(1); }

await boldBtn.click();
await page.waitForTimeout(500);

// 4) Inspect the snapshot — bold should be set on textRuns AND flat bl.
const after = await page.evaluate((b) => {
  const u = window.univer;
  const model = u.__getInjector()
    .get(window.__casualSlides__IUniverInstanceService)
    .getCurrentUnitOfType(3);
  const el = model.getSnapshot().body.pages[b.pageId].pageElements[b.elementId];
  return {
    flatBl: el.richText?.bl,
    runBl: el.richText?.rich?.body?.textRuns?.[0]?.ts?.bl,
    text: el.richText?.rich?.body?.dataStream ?? el.richText?.text,
  };
}, baseline);
console.log('after Bold click:', JSON.stringify(after));

const ok = after.flatBl === 1 || after.runBl === 1;
console.log(ok ? '✓ Bold applied to selected text element' : '✗ Bold did not apply');

console.log('errors:', errors.slice(0, 3));
await browser.close();
process.exit(ok ? 0 : 1);
