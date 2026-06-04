// Page Setup round-trip: switch to Standard 4:3, save .pptx, reopen, verify
// the imported deck still reads 4:3 dimensions.

import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('pageSize survives pptx round-trip after Page Setup change', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  const readSize = async () => page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    return inst.getCurrentUnitOfType(3).getPageSize();
  });

  // Switch to Standard 4:3
  await page.getByRole('button', { name: /^File$/ }).click();
  await page.waitForTimeout(300);
  await page.locator('button, [role="menuitem"]').filter({ hasText: /page setup/i }).first().click();
  await page.waitForTimeout(500);
  await page.locator('.cs-pagesetup__option').filter({ hasText: /standard 4:3/i }).first().click();
  await page.waitForTimeout(200);
  await page.locator('.cs-pagesetup button.cs-btn--accent, .cs-pagesetup button').filter({ hasText: /^apply$/i }).first().click();
  await page.waitForTimeout(700);

  const beforeSave = await readSize();
  console.log('size before save:', JSON.stringify(beforeSave));
  expect(beforeSave.height / beforeSave.width).toBeGreaterThan(0.7); // ~0.75 for 4:3

  // Save → re-import
  const dl = page.waitForEvent('download', { timeout: 15_000 });
  await page.keyboard.press('Control+s');
  const download = await dl;
  const tmp = join(tmpdir(), `pagesz-${Date.now()}.pptx`);
  await download.saveAs(tmp);
  const buf = await fs.readFile(tmp);
  await page.evaluate(async ({ bytes }) => {
    const blob = new Blob([new Uint8Array(bytes)]);
    const file = new File([blob], 'in.pptx', { type: blob.type });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('input[type="file"]');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { bytes: Array.from(buf) });
  await page.waitForTimeout(2500);

  const afterReopen = await readSize();
  console.log('size after reopen:', JSON.stringify(afterReopen));
  // 4:3 ratio: height/width ≈ 0.75. 16:9 (the default): ≈ 0.56.
  const ratio = afterReopen.height / afterReopen.width;
  expect(ratio, `expected 4:3 dimensions to survive round-trip; got ${afterReopen.width}×${afterReopen.height} (ratio ${ratio.toFixed(2)})`)
    .toBeGreaterThan(0.7);
  await fs.unlink(tmp).catch(() => {});
});
