import { test } from '@playwright/test';

test('find every canvas in the dom + size', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(3000);
  const list = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('canvas').forEach((c, i) => {
      const r = c.getBoundingClientRect();
      const path = [];
      let n = c;
      while (n && n !== document.body) {
        const tag = n.tagName?.toLowerCase() ?? '?';
        const cls = typeof n.className === 'string' ? n.className.split(' ')[0] : '';
        path.unshift(`${tag}${cls ? '.' + cls : ''}`);
        n = n.parentElement;
      }
      out.push({
        idx: i,
        w: c.width,
        h: c.height,
        rectW: Math.round(r.width),
        rectH: Math.round(r.height),
        rectX: Math.round(r.left),
        rectY: Math.round(r.top),
        path: path.join(' > '),
      });
    });
    return out;
  });
  for (const c of list) {
    console.log(`canvas[${c.idx}] ${c.w}×${c.h} (rect ${c.rectW}×${c.rectH} @ ${c.rectX},${c.rectY})`);
    console.log(`           path: ${c.path}`);
  }
});
