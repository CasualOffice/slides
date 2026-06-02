// Probe: with the FOCUSING_DOC flag now set, do Ctrl+B / Shift+Arrow / Ctrl+A
// inside the editor behave like Google Slides? Specifically, does Ctrl+B on
// a SELECTION bold only that selection (creating multiple textRuns)?

import { test } from '@playwright/test';

const passes = []; const issues = [];
function log(s, ok, otherwise) {
  if (ok) { passes.push(s); console.log(`✓ [${s}]`); }
  else { issues.push({ s, o: otherwise }); console.log(`❌ [${s}] ${otherwise}`); }
}

async function getTitleRich(page) {
  return await page.evaluate(() => {
    const w = window;
    const inst = w.univer.__getInjector().get(w.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const snap = unit.getSnapshot();
    const pageId = snap.body.pageOrder[0];
    const page = snap.body.pages[pageId];
    for (const el of Object.values(page.pageElements)) {
      if (el.id?.includes('title')) return el.richText;
    }
    return undefined;
  });
}

test('inline selection + formatting inside editor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  const t = await page.evaluate(() => {
    const w = window;
    const inst = w.univer.__getInjector().get(w.__casualSlides__IUniverInstanceService);
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

  // Enter edit mode
  await page.mouse.dblclick(t.cx, t.cy);
  await page.waitForTimeout(700);
  // Replace placeholder with known text
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(150);
  await page.keyboard.type('HelloWorld', { delay: 30 });
  await page.waitForTimeout(300);

  // ─── STEP 1: Shift+Home selects from end back to start
  await page.keyboard.down('Shift');
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(200);

  // ─── STEP 2: Ctrl+B on the selection
  await page.keyboard.press('Control+b');
  await page.waitForTimeout(300);

  // ─── STEP 3: Escape to commit (chrome-click goes through a different
  // path that doesn't call endEditing)
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  const rich = await getTitleRich(page);
  console.log('after select-all + Ctrl+B:', JSON.stringify(rich, null, 2));

  // Should have ≥ 1 textRun with bl: 1 covering most of "HelloWorld"
  const runs = rich?.rich?.body?.textRuns ?? [];
  const hasBoldRun = runs.some((r) => r.ts?.bl === 1 && (r.ed - r.st) >= 5);
  log('inline-bold-on-selection', hasBoldRun, `expected a bold textRun covering selected chars, got ${JSON.stringify(runs)}`);

  // ─── STEP 4: Edit again, partial-select last 5 chars, italic them
  // Use the same title position
  const t2 = await page.evaluate(() => {
    const w = window;
    const inst = w.univer.__getInjector().get(w.__casualSlides__IUniverInstanceService);
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

  await page.mouse.dblclick(t2.cx, t2.cy);
  await page.waitForTimeout(700);
  // Move cursor to end
  await page.keyboard.press('End');
  await page.waitForTimeout(150);
  // Select last 5 chars
  await page.keyboard.down('Shift');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(200);
  await page.keyboard.press('Control+i');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);

  const rich2 = await getTitleRich(page);
  console.log('after partial-italic:', JSON.stringify(rich2, null, 2));
  const runs2 = rich2?.rich?.body?.textRuns ?? [];
  const hasItalic = runs2.some((r) => r.ts?.it === 1);
  log('partial-italic-on-selection', hasItalic, `expected an italic textRun, got ${JSON.stringify(runs2)}`);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`INLINE FORMAT — ${passes.length} PASS / ${issues.length} FAIL`);
  console.log('═'.repeat(70));
  for (const i of issues) console.log(`  ❌ ${i.s}: ${i.o}`);
});
