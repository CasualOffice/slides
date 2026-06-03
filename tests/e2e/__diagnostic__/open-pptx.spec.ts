import { expect, test } from '@playwright/test';
import { copyFileSync, existsSync } from 'node:fs';

// Diagnostic: capture before/after screenshots and DOM state for the
// Save + Open .pptx round-trip flow. Reproduces the "slides go blank
// after open" report.
//
// Run via:
//   pnpm exec playwright test tests/e2e/__diagnostic__/open-pptx.spec.ts --config=playwright.config.ts

test('open-pptx round-trip — capture canvas state', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      errors.push(`${msg.type()}: ${msg.text()}`);
    }
  });

  await page.goto('/');
  await page.waitForFunction(
    () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
    null,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(800);

  await page.screenshot({ path: testInfo.outputPath('1-before-save.png'), fullPage: true });

  // Capture canvas dimensions before Save.
  const beforeOpen = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll('canvas')) as HTMLCanvasElement[];
    return canvases.map((c) => {
      const r = c.getBoundingClientRect();
      return { w: r.width, h: r.height, dw: c.width, dh: c.height };
    });
  });
  console.log('====== canvases BEFORE open ======');
  console.log(JSON.stringify(beforeOpen, null, 2));

  // Save the default deck.
  const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
  // The save button is now labeled just "Save" (downloads as .pptx
  // by default). Earlier alpha shipped "Save .pptx".
  await page.keyboard.press('Control+s');
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  expect(downloadedPath).toBeTruthy();
  if (!existsSync(downloadedPath!)) throw new Error('download missing');

  const fixturePath = testInfo.outputPath('round-trip.pptx');
  copyFileSync(downloadedPath!, fixturePath);

  // Open it back.
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(fixturePath);
  await expect(page.locator('.spike-status')).toContainText(/loaded/i, { timeout: 10_000 });
  await page.waitForTimeout(1500);

  await page.screenshot({ path: testInfo.outputPath('2-after-open.png'), fullPage: true });

  // Capture canvas dimensions after Open.
  const afterOpen = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll('canvas')) as HTMLCanvasElement[];
    return canvases.map((c) => {
      const r = c.getBoundingClientRect();
      return { w: r.width, h: r.height, dw: c.width, dh: c.height };
    });
  });
  console.log('====== canvases AFTER open ======');
  console.log(JSON.stringify(afterOpen, null, 2));

  // Snapshot deck state.
  const deckState = await page.evaluate(() => {
    type W = {
      univer: { __getInjector(): { get(id: unknown): unknown } };
      __pptxImportedSnapshot?: unknown;
    };
    const w = window as unknown as W;
    return {
      importedSnapshot: w.__pptxImportedSnapshot,
      thumbnailSpans: Array.from(document.querySelectorAll('aside span')).map((el) => el.textContent),
    };
  });
  console.log('====== deck state AFTER open ======');
  console.log(JSON.stringify(deckState, null, 2).slice(0, 2000));

  console.log('====== ERRORS ======');
  for (const e of errors) console.log(e);

  expect(true).toBe(true);
});
