// After re-importing a deck, the dataStream paragraph separators are \n
// (from the pptx import) instead of Univer's standard \r. Per the
// project-univer-paragraph-separator memory, Univer requires \r as the
// paragraph break — \n WILL render invisibly.
//
// Probe: import a deck with multi-line text, then check whether the
// rendered title actually displays both lines or just collapses to one.

import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('separator after pptx round-trip is correct', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
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

  // Type two lines + save + reopen
  await page.mouse.dblclick(t.cx, t.cy);
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(150);
  await page.keyboard.type('Line A', { delay: 30 });
  await page.keyboard.press('Enter');
  await page.keyboard.type('Line B', { delay: 30 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
  await page.keyboard.press('Control+s');
  const download = await downloadPromise;
  const tmpPath = join(tmpdir(), `nl-${Date.now()}.pptx`);
  await download.saveAs(tmpPath);
  const buf = await fs.readFile(tmpPath);
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

  // Now probe the re-imported deck's title element separator
  const probe = await page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const snap = unit.getSnapshot();
    const pageId = snap.body.pageOrder[0];
    const page = snap.body.pages[pageId];
    for (const el of Object.values(page.pageElements)) {
      const ds = el.richText?.rich?.body?.dataStream;
      if (ds && ds.includes('Line A')) {
        return {
          dataStream: ds,
          hasBackR: ds.includes('\r'),
          hasBackN: ds.includes('\n'),
          paragraphs: el.richText?.rich?.body?.paragraphs,
        };
      }
    }
    return null;
  });
  console.log('separator probe:', JSON.stringify(probe, null, 2));
  // After the export side now normalises `\r` → `\n` for PptxGenJS, the
  // re-imported dataStream should be Univer-conformant `\r`-separated and
  // NOT contain a bare `\n` between paragraphs. (`\n` at end-of-stream
  // is fine — that's Univer's document-end marker.)
  expect(probe, 'reopened dataStream must use Univer paragraph separator').toBeTruthy();
  const between = probe.dataStream.replace(/\r?\n$/, '');
  expect(between, `between-line separator should be \\r, got ${JSON.stringify(between)}`)
    .toMatch(/Line A\rLine B/);
  await fs.unlink(tmpPath).catch(() => {});
});
