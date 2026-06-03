// Speaker notes: open notes panel, type into the textarea, verify the
// active slide's description (where notes are persisted per NotesPanel.tsx
// comment) holds the typed text.

import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('speaker notes textarea writes into the active slide description', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  // Reveal the notes panel via the public toggle
  await page.evaluate(() => {
    if (typeof window.__casualSlides_toggleNotes === 'function') window.__casualSlides_toggleNotes();
  });
  await page.waitForTimeout(500);

  const probe = `SpeakerNote-${Date.now().toString(36)}`;
  const textarea = page.locator('.cs-notes__textarea, textarea').first();
  await textarea.click();
  await textarea.fill(probe);
  await page.waitForTimeout(500);
  // NotesPanel debounces / pushes onBlur — blur the textarea.
  await page.keyboard.press('Tab');
  await page.waitForTimeout(800);

  const descriptionAfter = await page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const snap = unit.getSnapshot();
    const pageId = snap.body.pageOrder[0];
    return snap.body.pages[pageId].description;
  });
  console.log('description after type:', JSON.stringify(descriptionAfter));
  expect(descriptionAfter, 'expected typed notes to land in slide.description').toContain(probe);
});

test('speaker notes survive pptx round-trip', async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  await page.evaluate(() => { if (typeof window.__casualSlides_toggleNotes === 'function') window.__casualSlides_toggleNotes(); });
  await page.waitForTimeout(400);

  const probe = `NotesRoundTrip-${Date.now().toString(36)}`;
  const textarea = page.locator('.cs-notes__textarea, textarea').first();
  await textarea.click();
  await textarea.fill(probe);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(700);

  // Save → re-import
  const dl = page.waitForEvent('download', { timeout: 15_000 });
  await page.keyboard.press('Control+s');
  const download = await dl;
  const tmp = join(tmpdir(), `notes-rt-${Date.now()}.pptx`);
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

  const reopenDesc = await page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const snap = unit.getSnapshot();
    const pageId = snap.body.pageOrder[0];
    return snap.body.pages[pageId].description;
  });
  console.log('description after reopen:', JSON.stringify(reopenDesc));
  expect(reopenDesc ?? '', 'notes should survive pptx round-trip').toContain(probe);
  await fs.unlink(tmp).catch(() => {});
});
