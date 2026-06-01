// Deeper inspection: what DOES Univer do when we dblclick on a text element?
// Capture all DOM mutations + canvas events + Univer service state.

import { test } from '@playwright/test';

test('deep introspection of dblclick→edit flow', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => console.log(`[b ${m.type()}] ${m.text()}`));

  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  // Hook a MutationObserver before clicking
  await page.evaluate(() => {
    const seen = new Set();
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const el = n;
          // Log everything contenteditable-related that gets added
          if (el.hasAttribute?.('contenteditable') || el.querySelector?.('[contenteditable]')) {
            console.log(`+CE node ${el.tagName}.${(el.className || '').toString().split(' ').slice(0,2).join('.')}`);
          }
          if (el.tagName === 'CANVAS' || el.querySelector?.('canvas')) {
            const cs = el.tagName === 'CANVAS' ? [el] : Array.from(el.querySelectorAll('canvas'));
            for (const c of cs) {
              const r = c.getBoundingClientRect();
              console.log(`+canvas ${c.width}x${c.height} rect=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
            }
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
    // Also log all canvas elements every 500ms to catch position shifts
    setInterval(() => {
      const canvases = Array.from(document.querySelectorAll('canvas'));
      const sigs = canvases.map((c) => { const r = c.getBoundingClientRect(); return `${c.width}x${c.height}@${Math.round(r.left)},${Math.round(r.top)}`; }).join(' | ');
      // eslint-disable-next-line no-console
      console.log(`canvases: ${sigs}`);
    }, 1000);
    console.log('mutation observer + canvas poller installed');
  });

  // Find main canvas + click title centre
  const map = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const c = canvases.reduce((b, x) => !b || x.getBoundingClientRect().width * x.getBoundingClientRect().height >
      b.getBoundingClientRect().width * b.getBoundingClientRect().height ? x : b, null);
    const r = c.getBoundingClientRect();
    return { cx: r.left + 480 + (r.width - 960) / 2, cy: r.top + 230 + (r.height - 540) / 2 };
  });
  console.log(`clicking title centre @ ${map.cx.toFixed(0)},${map.cy.toFixed(0)}`);

  await page.mouse.click(map.cx, map.cy);
  await page.waitForTimeout(500);
  console.log('--- after single click ---');

  await page.mouse.dblclick(map.cx, map.cy);
  await page.waitForTimeout(800);
  console.log('--- after double click ---');

  // Dump every contenteditable + every canvas
  const dump = await page.evaluate(() => {
    const ces = Array.from(document.querySelectorAll('[contenteditable]')).map((e) => {
      const r = e.getBoundingClientRect();
      return {
        tag: e.tagName,
        cls: typeof e.className === 'string' ? e.className : '',
        x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
        focused: document.activeElement === e,
        parent_cls: typeof e.parentElement?.className === 'string' ? e.parentElement.className : '',
      };
    });
    return { contenteditables: ces };
  });
  console.log('FULL CE DUMP:', JSON.stringify(dump, null, 2));
});
