// Capture the actual values feeding Univer's text-editor positioning
// formula so we can identify which input is producing the wrong overlay
// coords (-37, 66, w=0). Same observed behaviour on the default deck +
// imported pptx — so this is engine-level positioning math.

import { test } from '@playwright/test';

test('capture editor positioning math inputs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => console.log(`[b ${m.type()}] ${m.text()}`));

  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  // Patch slides-ui's internal positioning at runtime to log every input.
  // We can't easily intercept inside the minified bundle, so we just log
  // every relevant DOM measurement at the time of the double-click.
  const inspect = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const main = canvases.reduce((b, x) => !b || x.getBoundingClientRect().width * x.getBoundingClientRect().height >
      b.getBoundingClientRect().width * b.getBoundingClientRect().height ? x : b, null);
    const r = main.getBoundingClientRect();
    return {
      canvas_rect:        { x: r.left, y: r.top, w: r.width, h: r.height },
      canvas_style_w:     main.style.width,
      canvas_style_h:     main.style.height,
      canvas_attr_w:      main.width,
      canvas_attr_h:      main.height,
      // Univer's `_layoutService.getContentElement()` is the slide-ui
      // container. Find candidate parents.
      candidate_content_rects: ['.univer-mount', '.univer-flex', '.univer-relative', '#root', 'body'].map((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const rr = el.getBoundingClientRect();
        return { sel, x: rr.left, y: rr.top, w: rr.width, h: rr.height };
      }).filter(Boolean),
    };
  });
  console.log('CANVAS + content rects:\n', JSON.stringify(inspect, null, 2));

  // Compute scaleAdjust = canvasClientRect.width / pxToNum(canvas.style.width)
  const styleW = parseInt(inspect.canvas_style_w?.replace?.('px','') || 'NaN', 10);
  const scaleAdjust = inspect.canvas_rect.w / styleW;
  console.log(`scaleAdjust = ${inspect.canvas_rect.w} / ${styleW} = ${scaleAdjust}`);

  // The Univer math: startX = (slideLeft + canvasOffset) * scaleAdjust + (canvasRect.left - contentRect.left)
  // Need to know which content rect Univer uses. Probe the dom.
  const layoutInfo = await page.evaluate(() => {
    const w = window;
    try {
      const inj = w.univer.__getInjector();
      // Try to find the layout service via its identifier
      // ILayoutService is the standard Univer one
      const ILayoutService = Object.keys(w).find((k) => k.includes('ILayoutService'));
      console.log('ILayoutService key found?:', ILayoutService);
      // Lots of unknowns here — just attempt to introspect
      return { ok: true };
    } catch (e) { return { error: String(e) }; }
  });
});
