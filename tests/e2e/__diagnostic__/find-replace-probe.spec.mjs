// Find + Replace: type known text, press Ctrl+F, search for a substring,
// replace it, verify the model updates.

import { test, expect } from '@playwright/test';

test('Ctrl+F opens find/replace and replace updates the model', async ({ page }) => {
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

  // 1. Type known text into the title
  await page.mouse.dblclick(t.cx, t.cy);
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(150);
  await page.keyboard.type('HelloAlice', { delay: 30 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  // 2. Press Ctrl+F to open find/replace
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(500);

  // Look for the find dialog
  const dialogVisible = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[role="dialog"]')).map((d) => ({
      visible: d.checkVisibility?.() ?? true,
      text: (d.textContent || '').slice(0, 80),
    }));
  });
  console.log('dialogs after Ctrl+F:', dialogVisible);

  // 3. Type a search term in the find input
  const findInput = page.locator('[role="dialog"] input').first();
  await findInput.fill('Alice');
  await page.waitForTimeout(300);

  // 4. Expand the replace row (collapsed by default)
  await page.locator('[role="dialog"] button[aria-expanded="false"]').first().click().catch(() => {});
  await page.waitForTimeout(200);

  // 5. Fill the replace input
  const replaceInput = page.locator('[role="dialog"] input').nth(1);
  await replaceInput.fill('Bob');
  await page.waitForTimeout(300);

  // 6. Click the Replace button
  await page.getByRole('button', { name: /^Replace$/i }).first().click().catch(() => {});
  await page.waitForTimeout(700);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // 6. Verify the title now contains "HelloBob"
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
  console.log('title after replace:', JSON.stringify(titleAfter));
  expect(JSON.stringify(titleAfter), `expected 'Bob' in title after replace`).toContain('Bob');
  expect(JSON.stringify(titleAfter), `'Alice' should be gone after replace`).not.toContain('Alice');
});
