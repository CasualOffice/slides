// File ▸ Properties opens a dialog with the deck name, slide count, and
// size. Verify it shows accurate values for the current deck.

import { test, expect } from '@playwright/test';

test('Properties dialog reflects current deck stats', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  // Add a couple of slides so the count is non-default
  await page.keyboard.press('Control+m');
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+m');
  await page.waitForTimeout(300);

  // Open File menu → Properties
  await page.getByRole('button', { name: /^File$/ }).click();
  await page.waitForTimeout(300);
  const items = [/properties/i, /file info/i, /document properties/i];
  let clicked = false;
  for (const r of items) {
    const m = page.locator('button, [role="menuitem"]').filter({ hasText: r }).first();
    if (await m.isVisible({ timeout: 500 }).catch(() => false)) {
      await m.click();
      clicked = true;
      console.log('clicked matching:', String(r));
      break;
    }
  }
  expect(clicked, 'expected Properties menu item').toBe(true);
  await page.waitForTimeout(600);

  // Read all the dialog text
  const dialogText = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]');
    return (dlg?.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
  console.log('dialog text:', dialogText.slice(0, 300));
  expect(dialogText.length, 'dialog should have content').toBeGreaterThan(20);
  // The current deck has 3 slides; the dialog should show "Slides3"
  // (whitespace stripped by the regex above; the rendered UI has them
  // on separate lines).
  expect(dialogText, 'dialog should report 3 slides').toMatch(/slides\s*3(?!\d)/i);
});
