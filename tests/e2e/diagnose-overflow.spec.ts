import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Diagnostic — load the user's sample deck and dump EVERYTHING about
// the first few slides' text frames: parsed element bounds, document
// body, canvas pixel measurements. No assertions; this is to read.

test('diagnose: open "Your big idea.pptx" and dump text-frame state', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}\n${err.stack ?? ''}`));

  test.setTimeout(240_000);

  await page.addInitScript(() => {
    (window as unknown as { __csVerticalProbe?: unknown[] }).__csVerticalProbe = [];
  });
  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
    null,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(800);

  // Upload the sample deck.
  const buf = readFileSync(path.resolve(__dirname, 'fixtures/your-big-idea.pptx'));
  await page.locator('input[type="file"]').setInputFiles({
    name: 'your-big-idea.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    buffer: buf,
  });
  await page.waitForFunction(
    () => (document.querySelector('.cs-titlebar__pill--status') as HTMLElement | null)?.innerText.includes('Loaded'),
    null,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(1500);

  // Dump first 3 slides' element snapshot from the slide model.
  const dump = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const inst = w.univer.__getInjector().get(w.__casualSlides__IUniverInstanceService);
    const model = inst.getCurrentUnitOfType(3);
    const snap = model.getSnapshot();
    const order = snap?.body?.pageOrder ?? [];
    const out: Array<Record<string, unknown>> = [];
    // Dump slide 11 — title overflows top.
    const interesting = [10];
    for (const i of interesting.filter((j) => j < order.length)) {
      const page = snap.body.pages[order[i]];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const els = Object.values(page?.pageElements ?? {}) as any[];
      out.push({
        slideId: page?.id,
        bg: page?.pageBackgroundFill,
        elementCount: els.length,
        elements: els.map((e) => ({
          id: e.id,
          zIndex: e.zIndex,
          type: e.type,
          left: e.left,
          top: e.top,
          width: e.width,
          height: e.height,
          textPreview: typeof e.richText?.text === 'string' ? e.richText.text.slice(0, 80) : undefined,
          shapeFill: e.shape?.shapeProperties?.shapeBackgroundFill,
          shapeOutline: e.shape?.shapeProperties?.outline,
          fs: e.richText?.fs,
          ff: e.richText?.ff,
          docStyleMargins: e.richText?.rich?.documentStyle ? {
            ml: e.richText.rich.documentStyle.marginLeft,
            mt: e.richText.rich.documentStyle.marginTop,
            mr: e.richText.rich.documentStyle.marginRight,
            mb: e.richText.rich.documentStyle.marginBottom,
            anchor: e.richText.rich.documentStyle.renderConfig?.verticalAlign,
          } : null,
          paraCount: e.richText?.rich?.body?.paragraphs?.length,
          runCount: e.richText?.rich?.body?.textRuns?.length,
          firstRunStyle: e.richText?.rich?.body?.textRuns?.[0]?.ts,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          allRuns: (e.richText?.rich?.body?.textRuns ?? []).map((r: any) => ({ st: r.st, ed: r.ed, ts: r.ts })),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          paragraphs: (e.richText?.rich?.body?.paragraphs ?? []).map((p: any) => ({ start: p.startIndex, bullet: p.bullet, lineSpacing: p.paragraphStyle?.lineSpacing, indentFirstLine: p.paragraphStyle?.indentFirstLine })),
          dataStreamPreview: typeof e.richText?.rich?.body?.dataStream === 'string'
            ? e.richText.rich.body.dataStream.slice(0, 80)
            : undefined,
          shapeType: e.shape?.shapeType,
        })),
      });
    }
    return out;
  });

  // First — switch to slide 11 so its scene is the active one with
  // RichText objects we can inspect.
  await page.locator('[data-u-comp="left-sidebar"] :text("11")').first().click().catch(() => {});
  await page.waitForTimeout(800);

  // Probe RichText objects from the renderer registry for slide 11.
  const richTextProbe = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = { found: 0, items: [] };
    // Walk the live scene by walking the global canvas → its parent
    // (Documents-the-renderer holds a `_documents` chain), or via the
    // global univer/injector chain. Cheaper path: every RichText is
    // also a child of some scene that's reachable from the active
    // canvas's wrapping Engine. Find via window.univer.__getInjector
    // and the IRenderManagerService (exposed as __casualSlides__IRMS
    // in the env — but if not, fall back to scanning).
    const token = w.__casualSlides__IRenderManagerService;
    let RM: { getRenderAll: () => Iterable<{ scene?: { getAllObjects: () => Iterable<unknown> } }> } | undefined;
    try {
      if (token && w.univer?.__getInjector) {
        RM = w.univer.__getInjector().get(token);
      }
    } catch (e) { out.injectorError = String(e); }
    if (!RM) { out.error = 'no RM exposed'; return out; }
    // Walk every renderer's scene → enumerate RichText shapes.
    for (const r of RM.getRenderAll()) {
      const scene = r.scene;
      if (!scene) continue;
      for (const obj of scene.getAllObjects()) {
        if (obj?.constructor?.name === 'RichText' || (obj.documentData && obj.documentSkeleton)) {
          out.found++;
          const ds = obj.documentSkeleton?.getSkeletonData?.();
          const page0 = ds?.pages?.[0];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let lineSummary: any[] = [];
          if (page0?.sections) {
            for (const section of page0.sections) {
              for (const col of section.columns ?? []) {
                for (const line of col.lines ?? []) {
                  lineSummary.push({
                    top: line.top,
                    lineHeight: line.lineHeight,
                    contentHeight: line.contentHeight,
                    paragraphStart: line.paragraphStart,
                  });
                }
              }
            }
          }
          out.items.push({
            id: obj.oKey ?? obj.id,
            width: obj.width,
            height: obj.height,
            pageCount: ds?.pages?.length,
            page0Width: page0?.width,
            page0Height: page0?.height,
            page0MarginTop: page0?.marginTop,
            page0MarginBottom: page0?.marginBottom,
            verticalAlign: obj.documentData?.documentStyle?.renderConfig?.verticalAlign,
            wrapStrategy: obj.documentData?.documentStyle?.renderConfig?.wrapStrategy,
            marginLeft: obj.documentData?.documentStyle?.marginLeft,
            marginTop: obj.documentData?.documentStyle?.marginTop,
            lineSummary: lineSummary.slice(0, 12),
          });
        }
      }
    }
    return out;
  });
  // eslint-disable-next-line no-console
  console.log('\n=== RICHTEXT PROBE (slide 11) ===\n' + JSON.stringify(richTextProbe, null, 2));

  // Pull the patched-in vertical probe — _verticalHandler calls grab
  // this.height vs pageHeight at each draw. If `this.height` is the
  // frame's authored bounds (428.8 for s11-el-2) we know
  // transformByState applied correctly; if it's something else the
  // patch isn't taking effect.
  const probeData = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arr = (window as any).__csVerticalProbe as Array<Record<string, unknown>> | undefined;
    return arr ? arr.slice(0, 80) : [];
  });
  // eslint-disable-next-line no-console
  console.log('\n=== _verticalHandler CALLS ===\n' + JSON.stringify(probeData, null, 2));

  // Measure the actual RichText runtime state — width/height + the
  // documentSkeleton's laid-out page count + per-page size. Reveals
  // whether the docs engine is paginating or applying weird line
  // spacing.
  const rendered = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const univer = w.univer;
    // Find the slide's first page scene → find RichText objects on it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = { scenes: [], richTexts: [] };
    // Walk the renderer registry for the active slide.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const RM = univer.__getInjector().get(w.__casualSlides__IRenderManagerService ?? ({} as any));
      out.rmType = typeof RM;
    } catch { /* ignore */ }
    // The slide instance keeps a reference to all scenes via Slide.getSlideRender.
    // Easier: scan window for the global canvas + extract via known DOM ids.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const canvases = Array.from(document.querySelectorAll('canvas')) as any[];
    out.canvases = canvases.map((c, i) => ({
      idx: i,
      w: c.width,
      h: c.height,
      cssW: c.clientWidth,
      cssH: c.clientHeight,
    }));
    return out;
  });

  // Take a screenshot of slide 1 area so we can SEE what's broken.
  const shotPath = test.info().outputPath('slide1.png');
  await page.screenshot({ path: shotPath, fullPage: false });

  // Now walk slides 2-21 — click each thumbnail by index in the slide bar.
  // The slide bar buttons are inside `data-u-comp="left-sidebar"`. The
  // numeric label is in a span. We click each, wait a beat, screenshot.
  for (let i = 2; i <= 21; i++) {
    try {
      // The thumbnail with text matching exact number `${i}`.
      const thumb = page.locator(`[data-u-comp="left-sidebar"] :text("${i}")`).first();
      await thumb.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      await thumb.click({ timeout: 5_000 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: test.info().outputPath(`slide${i}.png`), fullPage: false });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`slide ${i} click failed: ${(e as Error).message.split('\n')[0]}`);
      break;
    }
  }

  // eslint-disable-next-line no-console
  console.log('\n=== SLIDE MODEL DUMP ===\n' + JSON.stringify(dump, null, 2));
  // eslint-disable-next-line no-console
  console.log('\n=== CANVAS DIMENSIONS ===\n' + JSON.stringify(rendered, null, 2));
  // eslint-disable-next-line no-console
  console.log('\n=== SCREENSHOT ===\n' + shotPath);
  // eslint-disable-next-line no-console
  console.log('\n=== CONSOLE LOG SAMPLE ===\n' + logs.slice(0, 40).join('\n'));
});
