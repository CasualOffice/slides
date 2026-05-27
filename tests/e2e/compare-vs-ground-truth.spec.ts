import { test } from '@playwright/test';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Multi-fixture side-by-side comparison harness.
// Drop ANY .pptx into tests/e2e/fixtures/ and the test will:
//   1. Render it through our app, screenshot each slide.
//   2. Generate ground-truth PNGs via `soffice --headless --convert-to pdf`
//      + `pdftoppm` (cached in /tmp/groundtruth/<fixture-slug>/).
//   3. Emit a per-fixture comparison HTML pairing the two side by side.
//
// Run with `pnpm test:e2e -- compare-vs-ground-truth.spec.ts`.

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const GROUNDTRUTH_ROOT = '/tmp/groundtruth';

// Slugify a filename into a directory-safe key. "Your big idea.pptx" →
// "your-big-idea". Used both for the ground-truth cache dir and the
// generated comparison HTML's filename.
function slugify(name: string): string {
  return name
    .replace(/\.pptx$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Headless soffice → PDF → pdftoppm. Caches in /tmp/groundtruth/<slug>/.
// Returns the path to that directory (with slide-NN.png files inside).
// Skip-cached if the dir already exists with at least one .png.
function ensureGroundtruth(fixturePath: string, slug: string): string {
  const outDir = path.join(GROUNDTRUTH_ROOT, slug);
  if (existsSync(outDir)) {
    const pngs = readdirSync(outDir).filter((f) => f.endsWith('.png'));
    if (pngs.length > 0) return outDir;
  }
  mkdirSync(outDir, { recursive: true });
  // Use LibreOffice (soffice). Headless render to PDF, then convert PDF
  // pages to PNGs at 100 DPI. Errors bubble — caller catches.
  const pdfDir = path.join(outDir, '_pdf');
  mkdirSync(pdfDir, { recursive: true });
  execSync(
    `soffice --headless --convert-to pdf --outdir "${pdfDir}" "${fixturePath}"`,
    { stdio: 'pipe' },
  );
  const pdfName = path.basename(fixturePath).replace(/\.pptx$/i, '.pdf');
  const pdfPath = path.join(pdfDir, pdfName);
  if (!existsSync(pdfPath)) throw new Error(`soffice produced no PDF for ${fixturePath}`);
  // pdftoppm output: slide-1.png, slide-2.png ... ; the -r 150 flag bumps
  // resolution for crisper comparison. -png produces PNG output (default
  // is PPM).
  execSync(
    `pdftoppm -png -r 150 "${pdfPath}" "${path.join(outDir, 'slide')}"`,
    { stdio: 'pipe' },
  );
  // pdftoppm emits slide-1.png / slide-01.png depending on count. Normalise
  // to two-digit padding so downstream pairing keys are consistent.
  for (const f of readdirSync(outDir)) {
    if (!f.endsWith('.png')) continue;
    const m = f.match(/^slide-(\d+)\.png$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (m[1].length === 2) continue;
    const newName = `slide-${String(n).padStart(2, '0')}.png`;
    if (newName === f) continue;
    execSync(`mv "${path.join(outDir, f)}" "${path.join(outDir, newName)}"`, { stdio: 'pipe' });
  }
  return outDir;
}

// One test per fixture so failures isolate cleanly and Playwright UI
// shows which deck broke.
const fixtures = existsSync(FIXTURES_DIR)
  ? readdirSync(FIXTURES_DIR)
      .filter((f) => f.toLowerCase().endsWith('.pptx'))
      .filter((f) => {
        try {
          return statSync(path.join(FIXTURES_DIR, f)).isFile();
        } catch { return false; }
      })
  : [];

if (fixtures.length === 0) {
  test('compare: no fixtures found in tests/e2e/fixtures/', async () => {
    throw new Error(`Drop one or more .pptx files into ${FIXTURES_DIR}/ to enable the comparison harness.`);
  });
}

for (const fixtureName of fixtures) {
  test(`compare: ${fixtureName}`, async ({ page }) => {
    test.setTimeout(360_000);
    const slug = slugify(fixtureName);
    const fixturePath = path.join(FIXTURES_DIR, fixtureName);
    const outDir = test.info().outputPath('');
    mkdirSync(outDir, { recursive: true });

    // Build ground truth on first run; reuse cache on subsequent runs.
    let gtDir: string | null = null;
    try {
      gtDir = ensureGroundtruth(fixturePath, slug);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log(`Ground-truth generation failed for ${fixtureName}: ${(e as Error).message}`);
    }

    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(800);

    const buf = readFileSync(fixturePath);
    await page.locator('input[type="file"]').setInputFiles({
      name: fixtureName,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      buffer: buf,
    });
    await page.waitForFunction(
      () => (document.querySelector('.cs-titlebar__pill--status') as HTMLElement | null)?.innerText.includes('Loaded'),
      null,
      { timeout: 90_000 },
    );
    await page.waitForFunction(
      () => (document as Document & { fonts: { ready: Promise<unknown>; status: string } })
        .fonts.status === 'loaded',
      null,
      { timeout: 5_000 },
    ).catch(() => {});
    await page.waitForTimeout(1500);

    // Slide count from the slide model itself — more reliable than
    // counting thumbnails (we'd race the sidebar render otherwise).
    const slideCount = await page.evaluate(() => {
      const w = window as unknown as {
        univer?: { __getInjector: () => { get: (token: unknown) => unknown } };
        __casualSlides__IUniverInstanceService?: unknown;
      };
      try {
        const inst = w.univer!.__getInjector().get(w.__casualSlides__IUniverInstanceService!) as {
          getCurrentUnitOfType: (n: number) => { getSnapshot: () => { body?: { pageOrder?: string[] } } };
        };
        const model = inst.getCurrentUnitOfType(3);
        return model.getSnapshot().body?.pageOrder?.length ?? 0;
      } catch { return 0; }
    });

    const canvasBounds = await page.evaluate(() => {
      const ws = document.querySelector('.cs-workspace');
      if (!ws) return null;
      const r = ws.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    if (!canvasBounds) throw new Error('canvas region not found');

    const ourShots: string[] = [];
    const gtShots: string[] = [];
    for (let i = 1; i <= slideCount; i++) {
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

      if (gtDir) {
        const gtPath = path.join(gtDir, `slide-${String(i).padStart(2, '0')}.png`);
        gtShots.push(existsSync(gtPath) ? gtPath : '');
      } else {
        gtShots.push('');
      }
    }

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
              ${gt ? `<img src="${gt}" alt="gt-${idx + 1}" />` : '<div class="missing">no ground truth — install soffice + pdftoppm</div>'}
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
<title>Slide comparison · ${fixtureName}</title>
<style>
  body { font-family: -apple-system, sans-serif; margin: 16px; background: #1a1a1a; color: #eee; }
  h1 { margin: 0 0 16px; font-size: 18px; }
  h2 { margin: 24px 0 8px; font-size: 14px; color: #aaa; }
  .row { margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid #333; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .col { background: #2a2a2a; padding: 12px; border-radius: 8px; }
  .label { font-size: 11px; color: #888; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
  img { width: 100%; height: auto; display: block; background: #fff; border-radius: 4px; }
  .missing { padding: 16px; background: #333; color: #888; font-size: 12px; border-radius: 4px; }
</style>
</head>
<body>
<h1>${fixtureName} · ${ourShots.length} slides</h1>
${rows}
</body></html>`;

    const htmlPath = path.join(outDir, 'comparison.html');
    writeFileSync(htmlPath, html);
    // Copy to ~/Desktop for one-click access. Per-fixture filename so
    // multiple deck comparisons don't clobber each other.
    const deskPath = path.join(process.env.HOME || '/tmp', 'Desktop', `casual-slides-${slug}.html`);
    try { writeFileSync(deskPath, html); } catch { /* permission etc. — non-fatal */ }
    // eslint-disable-next-line no-console
    console.log(`\nCOMPARISON HTML: ${htmlPath}\nALSO AT: ${deskPath}\n`);
  });
}
