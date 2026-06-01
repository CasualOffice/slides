// Identify the element Univer's _layoutService.getContentElement() returns
// and its bounding rect — that's the y=487 mystery in the EDITING_BUGS doc.

import { test } from '@playwright/test';

test('probe layout service content element', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => console.log(`[b ${m.type()}] ${m.text()}`));

  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  // Try every Univer service identifier we know
  const result = await page.evaluate(() => {
    const w = window;
    const inj = w.univer.__getInjector();
    // Probe potential ILayoutService tokens by searching common patterns
    // among the globally-stashed identifiers (our app stashes them as
    // __casualSlides__I…). Look for layout-related ones.
    const knownIds = Object.keys(w).filter((k) => k.startsWith('__casualSlides__'));
    const out = { knownIds, layoutCandidates: [] };

    // Find any service that has a getContentElement method
    // Iterate over the dependency injector’s known keys if accessible
    try {
      const desc = inj.__getInjectorDescription?.() ?? null;
      out.injectorDesc = desc;
    } catch {}

    // Direct test: there is a known service id `ILayoutService` (univer.layout-service)
    // Try common variants
    for (const sym of ['ILayoutService', 'LayoutService']) {
      try {
        // Univer uses createIdentifier — we need the actual identifier object.
        // Skip if we can't construct it.
      } catch {}
    }

    // Alternative: walk the DOM and find every element with a
    // getBoundingClientRect.top ≈ 487 to identify what Univer is using.
    const all = document.querySelectorAll('*');
    const matches = [];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (Math.abs(r.top - 487) < 10 && r.width > 100) {
        matches.push({
          tag: el.tagName,
          cls: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
          id: el.id,
          top: Math.round(r.top),
          left: Math.round(r.left),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
      }
    }
    out.matchesNear487 = matches.slice(0, 10);

    // Also list all aside / nav / section elements
    const containers = Array.from(document.querySelectorAll('section, aside, nav, main, div.cs-workspace, div.univer-mount, div[role]'))
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          cls: typeof el.className === 'string' ? el.className.slice(0, 60) : '',
          x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
        };
      })
      .filter((c) => c.w > 100 && c.h > 50);
    out.containers = containers.slice(0, 15);

    return out;
  });
  console.log(JSON.stringify(result, null, 2));
});
