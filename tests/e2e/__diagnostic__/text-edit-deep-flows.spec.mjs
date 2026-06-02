// Verify text-edit flows beyond "type-and-Escape":
//   - Enter creates a paragraph inside the editor (does NOT commit)
//   - Backspace deletes a character inside the editor
//   - Click outside the editor commits (without needing Escape)
//   - Multi-line text is preserved in the slide model

import { test } from '@playwright/test';

const OUT = '/tmp/casual-slides-deep-edit';
const passes = [];
const issues = [];
function log(s, ok, otherwise) {
  if (ok) { passes.push(s); console.log(`✓ [${s}]`); }
  else { issues.push({ s, o: otherwise }); console.log(`❌ [${s}] ${otherwise}`); }
}

async function snapshot(page) {
  return await page.evaluate(() => {
    const w = window;
    const inst = w.univer.__getInjector().get(w.__casualSlides__IUniverInstanceService);
    return inst.getCurrentUnitOfType(3)?.getSnapshot();
  });
}

async function titleText(page) {
  const snap = await snapshot(page);
  const page1 = snap?.body?.pages?.[snap.body.pageOrder[0]];
  if (!page1) return undefined;
  for (const el of Object.values(page1.pageElements)) {
    if (el.id?.includes('title') || el.title?.placeholderType === 'title') {
      const r = el.richText;
      const dataStream = r?.rich?.body?.dataStream;
      return { text: r?.text, dataStream };
    }
  }
  return undefined;
}

async function findTitleCentre(page) {
  return await page.evaluate(() => {
    const w = window;
    const inst = w.univer.__getInjector().get(w.__casualSlides__IUniverInstanceService);
    const unit = inst.getCurrentUnitOfType(3);
    const pageId = unit.getPageOrder()[0];
    const page = unit.getPage(pageId);
    let title;
    for (const el of Object.values(page.pageElements)) {
      if (el.id?.includes('title')) { title = el; break; }
    }
    if (!title) return null;
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const main = canvases.reduce((b, x) => !b || x.getBoundingClientRect().width * x.getBoundingClientRect().height >
      b.getBoundingClientRect().width * b.getBoundingClientRect().height ? x : b, null);
    const r = main.getBoundingClientRect();
    const scale = r.width / unit.getPageSize().width;
    return {
      cx: r.left + (title.left + title.width / 2) * scale,
      cy: r.top + (title.top + title.height / 2) * scale,
      r: { x: r.left, y: r.top, w: r.width, h: r.height },
    };
  });
}

test('drive deeper text-edit flows', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[err] ${m.text()}`); });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);

  const t = await findTitleCentre(page);
  if (!t) { log('setup', false, 'title not found'); return; }

  // ─── STEP 1: type a single-line line, then Enter, then another line
  await page.mouse.dblclick(t.cx, t.cy);
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(150);
  await page.keyboard.type('Line one', { delay: 30 });
  await page.keyboard.press('Enter');
  await page.keyboard.type('Line two', { delay: 30 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  const after1 = await titleText(page);
  console.log(`after Enter + multi-line: ${JSON.stringify(after1)}`);
  // Univer paragraph separator is \r (per memory). Two lines = "Line one\rLine two"
  const ds1 = after1?.dataStream ?? '';
  // Univer paragraph separator is \r (per project memory) — both lines preserved
  // AND a \r between them.
  const hasParagraphBreak = /Line one\rLine two/.test(ds1);
  log('1-enter-creates-paragraph', hasParagraphBreak, `expected 'Line one\\rLine two' in dataStream, got ${JSON.stringify(after1)}`);

  // ─── STEP 2: backspace deletes characters
  await page.mouse.dblclick(t.cx, t.cy);
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(150);
  await page.keyboard.type('ABCDE', { delay: 30 });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  const after2 = await titleText(page);
  console.log(`after Backspace x2 from 'ABCDE': ${JSON.stringify(after2)}`);
  const all2 = JSON.stringify(after2);
  log('2-backspace-deletes', /ABC/.test(all2) && !/ABCD/.test(all2),
    `expected 'ABC' (no 'D' or 'E'), got ${JSON.stringify(after2)}`);

  // ─── STEP 3: click outside commits without Escape
  await page.mouse.dblclick(t.cx, t.cy);
  await page.waitForTimeout(700);
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(150);
  await page.keyboard.type('Click-outside test', { delay: 30 });
  await page.waitForTimeout(300);
  // Click far outside the title — top of the canvas area, well away from the title
  const outsideX = t.r.x + t.r.w - 50;
  const outsideY = t.r.y + 30;
  await page.mouse.click(outsideX, outsideY);
  await page.waitForTimeout(700);
  const after3 = await titleText(page);
  console.log(`after click-outside: ${JSON.stringify(after3)}`);
  log('3-click-outside-commits', /Click-outside test/.test(JSON.stringify(after3)),
    `expected 'Click-outside test', got ${JSON.stringify(after3)}`);

  // ─── REPORT
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`DEEP TEXT-EDIT — ${passes.length} PASS / ${issues.length} FAIL`);
  console.log('═'.repeat(70));
  for (const i of issues) console.log(`  ❌ ${i.s}: ${i.o}`);
});
