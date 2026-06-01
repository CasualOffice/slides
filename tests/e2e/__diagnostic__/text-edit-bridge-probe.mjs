// Trace slide-editor-bridge state to find why double-click doesn't visually
// enter text-edit on a text element.
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') errors.push(t + ': ' + m.text());
});
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

// Locate.
const info = await page.evaluate(() => {
  const u = window.univer;
  const model = u.__getInjector().get(window.__casualSlides__IUniverInstanceService).getCurrentUnitOfType(3);
  const pageId = model.getActivePage().id;
  const els = model.getSnapshot().body.pages[pageId].pageElements;
  let id = null, el = null;
  for (const [k, v] of Object.entries(els)) {
    if (v.type === 2 || v.richText) { id = k; el = v; }
  }
  const canvases = Array.from(document.querySelectorAll('canvas'));
  const main = canvases.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  const r = main.getBoundingClientRect();
  return {
    pageId, id,
    snap: { left: el?.left, top: el?.top, width: el?.width, height: el?.height },
    canvas: { x: r.x, y: r.y, w: r.width, h: r.height },
  };
});
console.log('info:', JSON.stringify(info));

const SCENE_W = 1500, SCENE_H = 843;
const cx = info.canvas.x + (info.snap.left + info.snap.width / 2) * (info.canvas.w / SCENE_W);
const cy = info.canvas.y + (info.snap.top + info.snap.height / 2) * (info.canvas.h / SCENE_H);

// Single click first to select the transformer, then double-click.
await page.mouse.click(cx, cy);
await page.waitForTimeout(200);
await page.mouse.dblclick(cx, cy);
await page.waitForTimeout(500);

// Now poke around looking for the editor-bridge's currentEditingObject + visible state.
const bridge = await page.evaluate(() => {
  const u = window.univer;
  if (!u) return { err: 'no univer' };
  const inj = u.__getInjector();
  // Univer's services are registered by string identifier in the
  // ISlideEditorBridgeService token — try common names.
  const tokens = [
    'ISlideEditorBridgeService',
    'ISlideEditorManagerService',
    'SlideEditorBridgeService',
  ];
  const out = {};
  for (const name of tokens) {
    try {
      const svc = inj.get(name);
      if (svc) {
        const keys = Object.keys(svc).slice(0, 20);
        out[name] = { keys };
        // probe a few useful getters
        try { out[name].state = svc.getEditCellState?.() ?? svc.state ?? null; } catch {}
        try { out[name].visible = svc.getVisible?.() ?? svc.visible ?? null; } catch {}
      }
    } catch { /* not registered with that string token */ }
  }
  // Enumerate any DOM editor element.
  const editorCanvases = Array.from(document.querySelectorAll('canvas')).map((c, i) => ({
    i,
    w: c.width,
    h: c.height,
    cssW: c.style.width,
    cssH: c.style.height,
    parent: c.parentElement?.className || c.parentElement?.tagName,
  }));
  // Search for editor container div
  const editorDom = Array.from(document.querySelectorAll('[data-u-comp*="editor"], [class*="cell-editor"], [class*="rich-editor"]')).map((el) => ({
    tag: el.tagName,
    cls: el.className,
    rect: el.getBoundingClientRect(),
  }));
  return { tokens: out, editorCanvases, editorDom };
});
console.log('bridge probe:', JSON.stringify(bridge, null, 2));
console.log('errors:', errors.slice(0, 10));

await browser.close();
