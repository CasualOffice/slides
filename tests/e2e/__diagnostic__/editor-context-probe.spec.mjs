// Check whether docs-ui's BreakLine precondition is satisfied during slide edit.
// Precondition: FOCUSING_DOC && FOCUSING_UNIVER_EDITOR && !FOCUSING_COMMON_DRAWINGS

import { test } from '@playwright/test';

test('check FOCUSING_DOC during slide text edit', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  const t = await page.evaluate(() => {
    const w = window;
    const inst = w.univer.__getInjector().get(w.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const pageId = unit.getPageOrder()[0];
    const page = unit.getPage(pageId);
    let title; for (const el of Object.values(page.pageElements)) { if (el.id?.includes('title')) { title = el; break; } }
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const main = canvases.reduce((b, x) => !b || x.getBoundingClientRect().width * x.getBoundingClientRect().height >
      b.getBoundingClientRect().width * b.getBoundingClientRect().height ? x : b, null);
    const r = main.getBoundingClientRect();
    const scale = r.width / unit.getPageSize().width;
    return { cx: r.left + (title.left + title.width / 2) * scale, cy: r.top + (title.top + title.height / 2) * scale };
  });

  await page.mouse.dblclick(t.cx, t.cy);
  await page.waitForTimeout(700);
  await page.keyboard.type('A', { delay: 30 });
  await page.waitForTimeout(300);

  // Dynamically import IContextService from the Univer core bundle via DI walk
  const contextState = await page.evaluate(() => {
    const w = window;
    const inj = w.univer.__getInjector();
    // Walk the injector to find an instance with getContextValue + subscribeContextValue$
    // We can identify the ContextService instance via its method shape. Use a known
    // service that depends on it as a bridge — IUniverInstanceService doesn't help.
    // Simpler: inj._collection has a Map of name → instance. Try common names.
    const seen = [];
    const guesses = ['IContextService', 'ContextService', '_IContextService'];
    for (const name of guesses) {
      try {
        const svc = inj.get(name);
        if (svc?.getContextValue) {
          seen.push({ name, found: true });
          // Probe the context values
          const keys = ['doc-focusing', 'univer-editor-focusing', 'common-drawings-focusing'];
          const out = {};
          for (const k of keys) out[k] = svc.getContextValue(k);
          return out;
        }
      } catch (e) {}
    }
    // Fallback — walk all known injector entries
    try {
      const allKeys = inj._collection?._collection ? Array.from(inj._collection._collection.keys()) : [];
      return { tried_guesses: seen, all_inj_keys: allKeys.slice(0, 30) };
    } catch (e) { return { err: e.message }; }
  });
  console.log('CONTEXT during edit:', JSON.stringify(contextState, null, 2));

  // Try press Enter, see what dataStream looks like
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await page.keyboard.type('B', { delay: 30 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  const final = await page.evaluate(() => {
    const w = window;
    const inst = w.univer.__getInjector().get(w.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const snap = unit.getSnapshot();
    const pageId = snap.body.pageOrder[0];
    const page = snap.body.pages[pageId];
    let title; for (const el of Object.values(page.pageElements)) { if (el.id?.includes('title')) { title = el; break; } }
    return title.richText.rich?.body?.dataStream;
  });
  console.log('FINAL dataStream:', JSON.stringify(final));
});
