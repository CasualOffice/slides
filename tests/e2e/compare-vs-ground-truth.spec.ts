import { test } from '@playwright/test';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Side-by-side comparison: LibreOffice ground truth vs our Univer render.
// Outputs a single HTML page with two columns per slide so we can scan
// all 21 slides at a glance and pick the broken ones.

test('compare: render full sample deck and pair with ground-truth PNGs', async ({ page }) => {
  test.setTimeout(360_000);
  const groundtruthDir = '/tmp/groundtruth';
  const outDir = test.info().outputPath('');
  mkdirSync(outDir, { recursive: true });

  await page.goto('/');
  await page.waitForFunction(
    () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(800);

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
  // Wait for the dynamically-loaded Google Fonts to land — `display=swap`
  // means the canvas paints first with the system fallback then redraws
  // when the real font arrives. If we screenshot before fonts.ready,
  // we capture the fallback (wrong metrics, wrong wrap counts, wrong
  // typeface). Wait up to ~3 s; if a font is missing from Google
  // Fonts and never resolves, screenshot anyway.
  await page.waitForFunction(
    () => (document as Document & { fonts: { ready: Promise<unknown>; status: string } })
      .fonts.status === 'loaded',
    null,
    { timeout: 5_000 },
  ).catch(() => {});
  await page.waitForTimeout(1500);

  // Crop bounds for the slide canvas area in viewport coords. We screenshot
  // the rough canvas region and let the side-by-side handle scale.
  const canvasBounds = await page.evaluate(() => {
    const ws = document.querySelector('.cs-workspace');
    if (!ws) return null;
    const r = ws.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });

  if (!canvasBounds) throw new Error('canvas region not found');

  const ourShots: string[] = [];
  const gtShots: string[] = [];
  for (let i = 1; i <= 21; i++) {
    if (i > 1) {
      try {
        const thumb = page.locator(`[data-u-comp="left-sidebar"] :text("${i}")`).first();
        await thumb.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
        await thumb.click({ timeout: 5_000 });
        await page.waitForTimeout(700);
      } catch {
        break;
      }
    }
    const ourPath = path.join(outDir, `ours-${String(i).padStart(2, '0')}.png`);
    await page.screenshot({ path: ourPath, clip: canvasBounds });
    ourShots.push(ourPath);

    const gtPath = path.join(groundtruthDir, `slide-${String(i).padStart(2, '0')}.png`);
    gtShots.push(existsSync(gtPath) ? gtPath : '');
  }

  // Emit a comparison HTML referencing both image sets via data URIs so it
  // opens stand-alone without a web server.
  const toDataUri = (p: string): string => {
    if (!p) return '';
    const bytes = readFileSync(p);
    return `data:image/png;base64,${bytes.toString('base64')}`;
  };

  const rows = ourShots.map((_, idx) => {
    const ours = toDataUri(ourShots[idx]);
    const gt = toDataUri(gtShots[idx]);
    return `
      <section class="row">
        <h2>Slide ${idx + 1}</h2>
        <div class="pair">
          <div class="col">
            <div class="label">Ground truth (LibreOffice)</div>
            <img src="${gt}" alt="gt-${idx + 1}" />
          </div>
          <div class="col">
            <div class="label">Ours (Univer)</div>
            <img src="${ours}" alt="ours-${idx + 1}" />
          </div>
        </div>
      </section>`;
  }).join('\n');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>Slide comparison</title>
<style>
  body { font-family: -apple-system, sans-serif; margin: 16px; background: #1a1a1a; color: #eee; }
  h1 { margin: 0 0 16px; }
  h2 { margin: 24px 0 8px; font-size: 14px; color: #aaa; }
  .row { margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid #333; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .col { background: #2a2a2a; padding: 12px; border-radius: 8px; }
  .label { font-size: 11px; color: #888; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
  img { width: 100%; height: auto; display: block; background: #fff; border-radius: 4px; }
</style>
</head>
<body>
<h1>Slide rendering comparison · ${ourShots.length} slides</h1>
${rows}
</body></html>`;

  const htmlPath = path.join(outDir, 'comparison.html');
  writeFileSync(htmlPath, html);
  // eslint-disable-next-line no-console
  console.log(`\nCOMPARISON HTML: ${htmlPath}\n`);
});
