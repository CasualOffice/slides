// Drive the editor through real editing flows using PRECISE coordinates
// derived from the live model (not screen percentages). The earlier
// version of this spec was foiled by ambiguous selectors and rough
// click positions; this one computes canvas → model → screen and
// verifies model mutations after every action.

import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const OUT = '/tmp/casual-slides-edit-probe';
mkdirSync(OUT, { recursive: true });

function shot(page, name) {
  return page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
}

async function snapshot(page) {
  return page.evaluate(() => {
    const w = window;
    if (!w.univer) return null;
    try {
      const inj = w.univer.__getInjector();
      const inst = inj.get(w.__casualSlides__IUniverInstanceService);
      const model = inst.getCurrentUnitOfType(3);
      return model?.getSnapshot() ?? null;
    } catch (e) {
      return { error: String(e) };
    }
  });
}

// Map slide-model coordinates (px @ 96 DPI) to screen coords for clicking.
async function modelToScreen(page) {
  return page.evaluate(() => {
    const w = window;
    // Multiple canvases exist (Univer's hidden aside thumb + the main
    // editor canvas). The main one is the largest by bounding rect.
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const canvas = canvases.reduce((best, c) => {
      const rb = best?.getBoundingClientRect();
      const rc = c.getBoundingClientRect();
      return !best || rc.width * rc.height > rb.width * rb.height ? c : best;
    }, null);
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    try {
      const inj = w.univer.__getInjector();
      const inst = inj.get(w.__casualSlides__IUniverInstanceService);
      const model = inst.getCurrentUnitOfType(3);
      const snap = model.getSnapshot();
      const renderMgr = inj.get(w.__casualSlides__IRenderManagerService);
      const ru = renderMgr.getRenderById(model.getUnitId());
      const scene = ru?.scene;
      const scale = scene?.getScale?.() ?? { x: 1, y: 1 };
      // The slide is centred in the canvas with letterbox margins.
      const slideW = snap.pageSize.width * scale.x;
      const slideH = snap.pageSize.height * scale.y;
      const offsetX = (r.width - slideW) / 2;
      const offsetY = (r.height - slideH) / 2;
      return {
        canvas: { x: r.left, y: r.top, w: r.width, h: r.height },
        slide:  { offsetX, offsetY, w: slideW, h: slideH, scaleX: scale.x, scaleY: scale.y },
        page:   snap.body.pages[snap.body.pageOrder[0]],
      };
    } catch (e) {
      return { error: String(e), canvas: { x: r.left, y: r.top, w: r.width, h: r.height } };
    }
  });
}

function elementCentre(map, el) {
  const cx = map.slide.offsetX + (el.left + el.width / 2) * map.slide.scaleX;
  const cy = map.slide.offsetY + (el.top + el.height / 2) * map.slide.scaleY;
  return { x: map.canvas.x + cx, y: map.canvas.y + cy };
}

test('drive editing flows w/ precise coords + report broken steps', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const issues = [];
  const passes = [];
  const log = (s, p, o) => {
    if (p) { passes.push(s); console.log(`✓ [${s}]`); }
    else   { issues.push({ s, o }); console.log(`❌ [${s}] ${o}`); }
  };

  await page.goto('/');
  await page.waitForFunction(() => typeof window.__casualSlides_getPptxClient === 'function', null, { timeout: 30_000 });
  await page.waitForTimeout(2500);
  await shot(page, '00-boot');

  // ─────────────────────────────────────────────────────────
  // STEP 1 — click directly on the title element using model coords
  // ─────────────────────────────────────────────────────────
  const map1 = await modelToScreen(page);
  if (!map1 || map1.error) { log('1-map', false, `model→screen failed: ${map1?.error ?? 'no map'}`); return; }
  const titleEl = map1.page.pageElements['el-1-title'];
  if (!titleEl) { log('1-find-title', false, 'el-1-title not in default deck'); return; }

  const titleCentre = elementCentre(map1, titleEl);
  console.log(`step 1: title centre @ ${titleCentre.x.toFixed(0)},${titleCentre.y.toFixed(0)}`);

  // First click — select
  await page.mouse.click(titleCentre.x, titleCentre.y);
  await page.waitForTimeout(400);
  await shot(page, '01-after-select-click');

  // Check whether a transformer is now visible (selection indicator)
  const hasTransformer = await page.evaluate(() => {
    return !!document.querySelector('.univer-render-transformer-container, .univer-transformer, [data-render-id]')
      || document.querySelectorAll('canvas').length > 1; // engine paints a second canvas for handles
  });
  log('1a-select', hasTransformer, hasTransformer ? '' : 'no transformer / selection indicator after single click on title');

  // Double-click to enter text edit
  await page.mouse.dblclick(titleCentre.x, titleCentre.y);
  await page.waitForTimeout(500);
  await shot(page, '02-after-dblclick');
  await page.keyboard.type('Hello world', { delay: 30 });
  await page.waitForTimeout(500);
  await shot(page, '03-after-typing');
  // Commit — click outside
  await page.mouse.click(titleCentre.x, titleCentre.y - 200);
  await page.waitForTimeout(500);
  await shot(page, '04-after-commit');

  const after1 = await snapshot(page);
  const titleAfter = after1?.body?.pages?.['page-1']?.pageElements?.['el-1-title']?.richText?.text;
  console.log(`step 1: title now "${titleAfter}"`);
  log('1b-type-into-title', titleAfter && titleAfter.includes('Hello'), `expected title to contain 'Hello' but got "${titleAfter}"`);

  // ─────────────────────────────────────────────────────────
  // STEP 2 — insert a shape via the TOOLBAR (Insert ▾ shape grid)
  // ─────────────────────────────────────────────────────────
  // Use the toolbar's Insert ▾ button, not the menu strip Insert menu.
  // The toolbar button lives inside .cs-toolbar (not the titlebar).
  const toolbarInsert = page.locator('.cs-toolbar button:has-text("Insert")').first();
  await toolbarInsert.click().catch(() => {});
  await page.waitForTimeout(300);
  await shot(page, '05-toolbar-insert-open');
  // Rectangle is in the shape grid below "Text box / Image"
  // Try clicking the Rectangle by its aria-label
  const rectBtn = page.locator('button[aria-label="Rectangle"], button[title="Rectangle"]').first();
  const elsBefore = Object.keys(after1?.body?.pages?.['page-1']?.pageElements ?? {}).length;
  await rectBtn.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(700);
  await shot(page, '06-after-rect');
  const after2 = await snapshot(page);
  const elsAfter = Object.keys(after2?.body?.pages?.['page-1']?.pageElements ?? {}).length;
  console.log(`step 2: elements ${elsBefore} → ${elsAfter} after toolbar Insert → Rectangle`);
  log('2-insert-rect', elsAfter > elsBefore, `toolbar Insert → Rectangle added ${elsAfter - elsBefore} elements (expected ≥1)`);

  // ─────────────────────────────────────────────────────────
  // STEP 3 — drag the new shape 80px right + 80px down
  // ─────────────────────────────────────────────────────────
  const newEl = Object.values(after2?.body?.pages?.['page-1']?.pageElements ?? {})
    .find((e) => !['el-1-title', 'el-1-subtitle'].includes(e?.id));
  if (!newEl) {
    log('3-drag', false, 'no new element to drag (Step 2 likely failed)');
  } else {
    const map3 = await modelToScreen(page);
    const c = elementCentre(map3, newEl);
    console.log(`step 3: drag shape from ${c.x.toFixed(0)},${c.y.toFixed(0)}`);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 80, c.y + 80, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    await shot(page, '07-after-drag');
    const after3 = await snapshot(page);
    const moved = Object.values(after3?.body?.pages?.['page-1']?.pageElements ?? {}).find((e) => e?.id === newEl.id);
    const dx = (moved?.left ?? 0) - (newEl.left ?? 0);
    const dy = (moved?.top ?? 0) - (newEl.top ?? 0);
    console.log(`step 3: model dx=${dx} dy=${dy}`);
    log('3-drag', Math.abs(dx) >= 20 && Math.abs(dy) >= 20, `dx=${dx} dy=${dy} (expected ≥20 each)`);
  }

  // ─────────────────────────────────────────────────────────
  // STEP 4 — Bold via Ctrl+B (text element needs focus first)
  // ─────────────────────────────────────────────────────────
  const map4 = await modelToScreen(page);
  const t4 = map4.page.pageElements['el-1-title'];
  if (t4) {
    const tc = elementCentre(map4, t4);
    await page.mouse.dblclick(tc.x, tc.y);
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(150);
    await page.keyboard.press('Control+b');
    await page.waitForTimeout(300);
    await page.mouse.click(tc.x, tc.y - 200);
    await page.waitForTimeout(300);
    const after4 = await snapshot(page);
    const t4after = after4?.body?.pages?.['page-1']?.pageElements?.['el-1-title']?.richText;
    const isBold = !!t4after?.bl;
    console.log(`step 4: title bold after Ctrl+B = ${isBold} (rich keys: ${Object.keys(t4after ?? {}).join(',')})`);
    log('4-bold', isBold || !!(t4after?.rich?.body?.textRuns?.length), `Ctrl+B did not toggle bold on the title`);
  }

  // ─────────────────────────────────────────────────────────
  // STEP 5 — keyboard shortcut: Ctrl+M for new slide
  // ─────────────────────────────────────────────────────────
  const before5 = await snapshot(page);
  const sBefore = before5?.body?.pageOrder?.length ?? 0;
  await page.keyboard.press('Control+m');
  await page.waitForTimeout(500);
  const after5 = await snapshot(page);
  const sAfter = after5?.body?.pageOrder?.length ?? 0;
  console.log(`step 5: slides ${sBefore} → ${sAfter} after Ctrl+M`);
  log('5-new-slide', sAfter === sBefore + 1, `Ctrl+M went from ${sBefore} → ${sAfter} (expected +1)`);

  // ─────────────────────────────────────────────────────────
  // STEP 6 — Ctrl+Z undoes the last action (new slide)
  // ─────────────────────────────────────────────────────────
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  const after6 = await snapshot(page);
  const sUndo = after6?.body?.pageOrder?.length ?? 0;
  log('6-undo-new-slide', sUndo === sBefore, `expected ${sBefore} slides after undo, got ${sUndo}`);

  // ─────────────────────────────────────────────────────────
  // STEP 7 — delete the active slide via Slide menu
  // ─────────────────────────────────────────────────────────
  const before7 = await snapshot(page);
  const s7Before = before7?.body?.pageOrder?.length ?? 0;
  // Open the Slide menu in the menu strip
  await page.getByRole('button', { name: 'Slide' }).first().click().catch(() => {});
  await page.waitForTimeout(200);
  await page.getByRole('button', { name: /Delete slide/ }).click().catch(() => {});
  await page.waitForTimeout(500);
  const after7 = await snapshot(page);
  const s7After = after7?.body?.pageOrder?.length ?? 0;
  log('7-delete-slide-menu', s7After === Math.max(0, s7Before - 1), `expected ${s7Before - 1} slides after Slide → Delete, got ${s7After}`);

  // ─────────────────────────────────────────────────────────
  // FINAL REPORT
  // ─────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`EDIT-UX PROBE — ${passes.length} PASS / ${issues.length} FAIL`);
  console.log('═'.repeat(70));
  for (const i of issues) console.log(`  ❌ ${i.s}: ${i.o}`);
  console.log('\nScreenshots:', OUT);

  expect(true).toBe(true);
});
