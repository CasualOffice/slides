// Autosave restore: type a known string into the title, wait long enough for
// the autosave debounce to fire (30 s per the App's useEffect timer), reload
// the page, and verify the restore banner offers the autosaved content and
// applying it returns the typed text.

import { test, expect } from '@playwright/test';

test('autosave restores user work after page reload', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  const t = await page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
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

  const probe = `AutosaveProbe-${Date.now().toString(36)}`;
  await page.mouse.dblclick(t.cx, t.cy);
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(150);
  await page.keyboard.type(probe, { delay: 30 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  // Force-flush the autosave debounce manually if the app exposes it,
  // otherwise wait the full 30 s for the timer.
  const forced = await page.evaluate(() => {
    if (typeof window.__casualSlides_flushAutosave === 'function') {
      window.__casualSlides_flushAutosave();
      return true;
    }
    return false;
  });
  console.log('autosave forced:', forced);
  if (!forced) {
    // Debounce is 30 s after the latest mutation; wait extra for the
    // async IDB write to land after the timer fires.
    await page.waitForTimeout(33_000);
  } else {
    await page.waitForTimeout(800);
  }

  // Confirm an autosave entry exists in IndexedDB before reloading.
  // DB name comes from apps/web/src/storage/autosave.ts.
  const beforeReload = await page.evaluate(async () => {
    return new Promise((resolve) => {
      const req = indexedDB.open('casual-slides-autosave', 1);
      req.onerror = () => resolve({ err: 'open failed', name: req.error?.name });
      req.onsuccess = () => {
        const db = req.result;
        const names = Array.from(db.objectStoreNames);
        if (!names.includes('autosave')) { resolve({ stores: names, count: 0 }); return; }
        try {
          const tx = db.transaction('autosave', 'readonly');
          const store = tx.objectStore('autosave');
          const all = store.getAll();
          all.onsuccess = () => {
            const row = all.result?.[0];
            // Dig out the first text-element to see if our typed string made it
            let titleText;
            try {
              const snap = row?.snapshot;
              const pageId = snap?.body?.pageOrder?.[0];
              const page = snap?.body?.pages?.[pageId];
              for (const el of Object.values(page?.pageElements ?? {})) {
                if (el.id?.includes('title')) { titleText = el.richText?.text; break; }
              }
            } catch {}
            resolve({ stores: names, count: all.result?.length ?? 0, fileName: row?.fileName, savedAt: row?.savedAt, titleText });
          };
          all.onerror = () => resolve({ stores: names, err: 'getAll failed' });
        } catch (e) { resolve({ stores: names, err: String(e) }); }
      };
    });
  });
  console.log('IDB before reload:', JSON.stringify(beforeReload, null, 2));

  // Reload — simulates the "accidental tab refresh" case.
  await page.reload();
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(3000);

  // Look for the restore banner
  const bannerVisible = await page.evaluate(() => {
    const banners = Array.from(document.querySelectorAll('[role="status"], .cs-autosave-banner, [data-autosave-banner]'));
    return banners.map((el) => ({
      cls: typeof el.className === 'string' ? el.className.slice(0, 60) : '',
      text: (el.textContent || '').slice(0, 120),
    }));
  });
  console.log('banners after reload:', JSON.stringify(bannerVisible));

  // Click the restore button if found
  const restoreClicked = await page.getByRole('button', { name: /restore|recover/i }).first().click({ timeout: 3000 }).then(() => true).catch(() => false);
  console.log('restore button clicked:', restoreClicked);
  await page.waitForTimeout(2000);

  // Check the title text post-restore
  const titleAfter = await page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const snap = unit.getSnapshot();
    const pageId = snap.body.pageOrder[0];
    const page = snap.body.pages[pageId];
    for (const el of Object.values(page.pageElements)) {
      if (el.id?.includes('title')) return el.richText;
    }
  });
  console.log('title after restore:', JSON.stringify(titleAfter));
  expect(JSON.stringify(titleAfter), `expected ${probe} to come back after restore`).toContain(probe);
});
