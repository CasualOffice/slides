import { expect, test } from '@playwright/test';

// Smoke tests for the P0 spike. Bound the regression surface that bit us in
// production (LocaleService crash → black screen) and confirm the round-trip
// loop works end-to-end.

test.describe('Casual Slides — P0 spike smoke', () => {
  // Re-asserting nothing throws while mounting Univer. If a future plugin
  // registration breaks string lookups again the page-load assertion below
  // catches it.
  test('mounts Univer without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/');
    await expect(page.locator('.spike-banner')).toBeVisible();
    await expect(page.locator('.univer-mount')).toBeVisible();

    // Give Univer's plugin lifecycle (Starting → Ready → Rendered → Steady)
    // a moment to settle before sampling errors. Locale/render-engine bugs
    // surface within the first frame, well under this budget.
    await page.waitForTimeout(800);

    // Filter out third-party noise (e.g. fonts.googleapis when offline).
    // Anything from a Univer or app file is signal.
    const appErrors = errors.filter(
      (e) => !e.includes('fonts.googleapis') && !e.includes('favicon'),
    );
    expect(appErrors, `console errors during mount:\n${appErrors.join('\n')}`).toEqual([]);
  });

  test('spike banner exposes Save .pptx and Open .pptx', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /save \.pptx/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /open \.pptx/i })).toBeVisible();
  });

  test('Save .pptx triggers a download with a non-trivial blob', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto('/');
    // The rev probe is set after Univer's UI plugin finishes wiring — wait
    // on that instead of an arbitrary sleep.
    await page.waitForFunction(() => typeof (window as { __slideRevProbe?: unknown }).__slideRevProbe === 'function', null, { timeout: 15_000 });

    const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
    await page.getByRole('button', { name: /save \.pptx/i }).click();
    let download;
    try {
      download = await downloadPromise;
    } catch (e) {
      // Surface the in-page error/state instead of just "timed out".
      const status = await page.locator('.spike-status').textContent().catch(() => null);
      const error = await page.locator('.spike-error').textContent().catch(() => null);
      throw new Error(
        `Save .pptx did not produce a download.\n  status: ${status}\n  error: ${error}\n  console:\n${errors.map((e) => '    ' + e).join('\n')}`,
      );
    }

    expect(download.suggestedFilename()).toMatch(/\.pptx$/);

    const path = await download.path();
    expect(path).toBeTruthy();

    // The pptx is a zip; the magic number is "PK\x03\x04". Sanity-check it's
    // a valid archive without unzipping.
    const { readFileSync } = await import('node:fs');
    const head = readFileSync(path!).subarray(0, 4);
    expect(head[0]).toBe(0x50); // P
    expect(head[1]).toBe(0x4b); // K
    expect(head[2]).toBe(0x03);
    expect(head[3]).toBe(0x04);
  });

  test('rev-tracking patch is live (Gap 1)', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => typeof (window as { __slideRevProbe?: unknown }).__slideRevProbe === 'function', null, { timeout: 15_000 });

    // Pre-patch SlideDataModel.getRev() returned 0 forever and incrementRev
    // was a no-op. Post-patch it starts at 1 and bumps by one. The probe
    // calls incrementRev once and returns the new value.
    const result = await page.evaluate(() =>
      (window as { __slideRevProbe: () => number }).__slideRevProbe(),
    );
    expect(result).toBeGreaterThan(1);
  });
});
