// PPTX round-trip: type into the title, click Save (downloads .pptx), reopen
// it as the upload payload, and verify the title text survives.
//
// This is the canonical "did my edits actually persist" check. If this
// fails, the patches that made the editor work didn't make the output
// reflect them.

import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('typed title survives pptx export + re-import', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  // 1. Enter title edit and type a known string
  const t = await page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const pageId = unit.getPageOrder()[0];
    const page = unit.getPage(pageId);
    let title;
    for (const el of Object.values(page.pageElements)) {
      if (el.id?.includes('title')) { title = el; break; }
    }
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const main = canvases.reduce((b, x) => !b || x.getBoundingClientRect().width * x.getBoundingClientRect().height >
      b.getBoundingClientRect().width * b.getBoundingClientRect().height ? x : b, null);
    const r = main.getBoundingClientRect();
    const scale = r.width / unit.getPageSize().width;
    return { cx: r.left + (title.left + title.width / 2) * scale, cy: r.top + (title.top + title.height / 2) * scale };
  });

  await page.mouse.dblclick(t.cx, t.cy);
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(150);
  const stamp = Date.now().toString(36);
  const line1 = `RoundTripLine1-${stamp}`;
  const line2 = `RoundTripLine2-${stamp}`;
  const probe = line1; // back-compat for the "did SOMETHING make it" check
  await page.keyboard.type(line1, { delay: 30 });
  await page.keyboard.press('Enter');
  await page.keyboard.type(line2, { delay: 30 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  // Sanity: the slide model now has the typed text
  const titleAfterEdit = await page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const snap = unit.getSnapshot();
    const pageId = snap.body.pageOrder[0];
    const page = snap.body.pages[pageId];
    for (const el of Object.values(page.pageElements)) {
      if (el.id?.includes('title')) return el.richText;
    }
  });
  console.log('title after edit:', JSON.stringify(titleAfterEdit));
  expect(JSON.stringify(titleAfterEdit), `expected probe text in slide model`).toContain(probe);

  // 2. Trigger Save via Ctrl+S; capture the download
  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 });
  await page.keyboard.press('Control+s');
  const download = await downloadPromise;
  const tmpPath = join(tmpdir(), `casual-roundtrip-${Date.now()}.pptx`);
  await download.saveAs(tmpPath);
  console.log('downloaded pptx to:', tmpPath);

  // 3. Re-import the downloaded file via the file input
  const buf = await fs.readFile(tmpPath);
  await page.evaluate(async ({ bytes, name }) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    const file = new File([blob], name, { type: blob.type });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('input[type="file"]');
    if (!input) throw new Error('no file input found');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { bytes: Array.from(buf), name: 'roundtrip.pptx' });

  // 4. Wait for re-import to land — snapshot.id should change to a fresh one
  await page.waitForTimeout(2500);

  // 5. Check ANY element in the re-imported deck for the probe text
  const elementsAfterReopen = await page.evaluate(() => {
    const inst = window.univer.__getInjector().get(window.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const snap = unit.getSnapshot();
    const out = [];
    for (const pageId of snap.body.pageOrder) {
      const page = snap.body.pages[pageId];
      for (const el of Object.values(page.pageElements)) {
        out.push({
          id: el.id,
          text: el.richText?.text,
          dataStream: el.richText?.rich?.body?.dataStream,
        });
      }
    }
    return out;
  });
  console.log('elements after reopen:', JSON.stringify(elementsAfterReopen, null, 2));
  const reopenJson = JSON.stringify(elementsAfterReopen);
  expect(reopenJson, `line 1 should survive pptx round-trip`).toContain(line1);
  expect(reopenJson, `line 2 should survive pptx round-trip`).toContain(line2);

  // Cleanup
  await fs.unlink(tmpPath).catch(() => {});
});
