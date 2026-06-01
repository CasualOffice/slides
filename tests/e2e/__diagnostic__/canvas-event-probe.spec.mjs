// Diagnostic — does the Univer canvas receive pointer + key events at
// all, or are they being eaten by an overlay? Dump every interaction
// attempt with high verbosity.

import { test } from '@playwright/test';

test('canvas pointer/key event reach probe', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Hook console messages from the page
  page.on('console', (msg) => console.log(`[browser ${msg.type()}] ${msg.text()}`));

  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  // Install a pointerdown logger on the canvas
  await page.evaluate(() => {
    const canvases = document.querySelectorAll('canvas');
    canvases.forEach((c, i) => {
      c.addEventListener('pointerdown', (e) => {
        console.log(`canvas[${i}] pointerdown @ ${e.clientX},${e.clientY} button=${e.button}`);
      });
      c.addEventListener('dblclick', (e) => {
        console.log(`canvas[${i}] dblclick @ ${e.clientX},${e.clientY}`);
      });
    });
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      const tag = (t && t.tagName) || 'unknown';
      const editable = t && t.isContentEditable;
      console.log(`keydown ${e.key} target=${tag} editable=${editable}`);
    }, true);
    console.log(`installed listeners on ${canvases.length} canvas elements`);
  });

  // What's the topmost element at the title centre (480, 230) in slide coords?
  const map = await page.evaluate(() => {
    const canvas = document.querySelector('.univer-mount canvas');
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    const w = window;
    const inj = w.univer.__getInjector();
    const inst = inj.get(w.__casualSlides__IUniverInstanceService);
    const model = inst.getCurrentUnitOfType(3);
    const snap = model.getSnapshot();
    const renderMgr = inj.get(w.__casualSlides__IRenderManagerService);
    const ru = renderMgr.getRenderById(model.getUnitId());
    const scene = ru.scene;
    const t = scene?.transform;
    return {
      canvas: { x: r.left, y: r.top, w: r.width, h: r.height },
      scale: scene?.getScale?.() ?? null,
      transform: t ? { m: t.getMatrix?.() ?? null } : null,
      pageSize: snap.pageSize,
      transformerCanvases: document.querySelectorAll('canvas').length,
    };
  });
  console.log('MAP:', JSON.stringify(map, null, 2));

  // Compute where to click for the title element (left=80, top=180, w=800, h=100)
  // Element centre in slide coords = (480, 230)
  const sx = map.scale?.x ?? 1;
  const sy = map.scale?.y ?? 1;
  const slideRenderedW = map.pageSize.width * sx;
  const slideRenderedH = map.pageSize.height * sy;
  const offX = (map.canvas.w - slideRenderedW) / 2;
  const offY = (map.canvas.h - slideRenderedH) / 2;
  const clickX = map.canvas.x + offX + 480 * sx;
  const clickY = map.canvas.y + offY + 230 * sy;
  console.log(`computed click @ ${clickX.toFixed(0)},${clickY.toFixed(0)} (scale ${sx},${sy})`);

  // Use elementFromPoint to see what's at the click position
  const at = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return { tag: el?.tagName, cls: el?.className, parent: el?.parentElement?.tagName };
  }, { x: clickX, y: clickY });
  console.log(`elementFromPoint(${clickX.toFixed(0)},${clickY.toFixed(0)}):`, at);

  // Single click
  await page.mouse.click(clickX, clickY);
  await page.waitForTimeout(400);

  // Double click for text edit
  await page.mouse.dblclick(clickX, clickY);
  await page.waitForTimeout(500);

  // Try typing
  await page.keyboard.type('TEST', { delay: 50 });
  await page.waitForTimeout(500);

  // Snapshot
  const snap = await page.evaluate(() => {
    const w = window;
    const inj = w.univer.__getInjector();
    const inst = inj.get(w.__casualSlides__IUniverInstanceService);
    const model = inst.getCurrentUnitOfType(3);
    return model.getSnapshot();
  });
  console.log('title after type:', JSON.stringify(snap.body.pages['page-1'].pageElements['el-1-title']?.richText));
});
