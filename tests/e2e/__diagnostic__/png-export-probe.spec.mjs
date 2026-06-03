// PNG export: File menu → Download as PNG. Verify a PNG download fires and
// the bytes are a valid PNG (magic header 89 50 4e 47).

import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('PNG export downloads valid bytes', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });

  // Open the File menu and click "Download as PNG" (or similar)
  await page.getByRole('button', { name: /^File$/ }).click();
  await page.waitForTimeout(300);
  // The menu item label is i18n-keyed; try multiple
  const tries = [/download slide as png/i, /png/i];
  let clicked = false;
  for (const r of tries) {
    const matches = page.locator('[role="menuitem"], button').filter({ hasText: r });
    if (await matches.first().isVisible({ timeout: 500 }).catch(() => false)) {
      await matches.first().click().catch(() => {});
      clicked = true;
      console.log('clicked menu item matching:', String(r));
      break;
    }
  }
  expect(clicked, 'Download PNG menu item should be visible').toBe(true);

  const download = await downloadPromise;
  const tmp = join(tmpdir(), `png-export-${Date.now()}.png`);
  await download.saveAs(tmp);
  const buf = await fs.readFile(tmp);
  console.log('downloaded bytes:', buf.length, 'header:', Array.from(buf.subarray(0, 8)).map((b) => b.toString(16)).join(' '));
  // PNG magic: 89 50 4e 47 0d 0a 1a 0a
  expect(buf[0]).toBe(0x89);
  expect(buf[1]).toBe(0x50);
  expect(buf[2]).toBe(0x4e);
  expect(buf[3]).toBe(0x47);
  expect(buf.length).toBeGreaterThan(1000);
  await fs.unlink(tmp).catch(() => {});
});

test('PDF export downloads valid bytes', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err-pdf] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });

  await page.getByRole('button', { name: /^File$/ }).click();
  await page.waitForTimeout(300);
  const tries = [/download deck as pdf/i, /pdf/i];
  let clicked = false;
  for (const r of tries) {
    const matches = page.locator('[role="menuitem"], button').filter({ hasText: r });
    if (await matches.first().isVisible({ timeout: 500 }).catch(() => false)) {
      await matches.first().click().catch(() => {});
      clicked = true;
      console.log('clicked menu item matching:', String(r));
      break;
    }
  }
  expect(clicked, 'Download PDF menu item should be visible').toBe(true);

  const download = await downloadPromise;
  const tmp = join(tmpdir(), `pdf-export-${Date.now()}.pdf`);
  await download.saveAs(tmp);
  const buf = await fs.readFile(tmp);
  console.log('downloaded bytes:', buf.length, 'header:', buf.subarray(0, 5).toString('ascii'));
  // PDF magic: "%PDF-"
  expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  expect(buf.length).toBeGreaterThan(1000);
  await fs.unlink(tmp).catch(() => {});
});
