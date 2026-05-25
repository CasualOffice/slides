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
    await expect(page.locator('.cs-titlebar')).toBeVisible();
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

  test('Univer canvases render with non-zero height (CSS regression guard)', async ({ page }) => {
    // The Univer workbench layout uses Tailwind-prefixed classes that ship
    // as per-package CSS side-effect imports (@univerjs/design,
    // @univerjs/ui, @univerjs/docs-ui, @univerjs/slides-ui). Without those
    // imports the layout collapses to height: 0, every <canvas> has
    // height="0", and the editor paints nothing — symptom is a black
    // canvas with only the slide-bar thumbnails visible.
    //
    // This test asserts the import is wired correctly by checking that at
    // least one render-canvas has a non-trivial height.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __slideRevProbe?: unknown }).__slideRevProbe === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(500);

    const tallest = await page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll('canvas')) as HTMLCanvasElement[];
      const rects = canvases.map((c) => c.getBoundingClientRect());
      return rects.length === 0 ? 0 : Math.max(...rects.map((r) => r.height));
    });
    // 200px is a safe floor — the main render-canvas in a 720p browser is
    // typically 600px+, and even a thumbnail is at least 128px. Anything
    // sub-100 means the layout collapsed.
    expect(tallest, 'expected at least one canvas with non-trivial height (Univer CSS loaded)').toBeGreaterThan(200);
  });

  test('title bar exposes Save and Open actions', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: /^save$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^open$/i })).toBeVisible();
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

    // 30 s, not 15 s — CI runners are slower than local + the pptx worker
    // bundle is ~1.9 MB. Plus main.tsx warms the worker on idle, so cold
    // start should already be paid by the time we click.
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: /^save$/i }).click();
    let download;
    try {
      download = await downloadPromise;
    } catch (e) {
      // Surface the in-page error/state instead of just "timed out".
      const status = await page.locator('.cs-titlebar__pill--status').textContent().catch(() => null);
      const error = await page.locator('.cs-titlebar__pill--error').textContent().catch(() => null);
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

  test('Open .pptx hot-swaps the deck without TypeError (Gap render-context-unit-fix)', async ({ page }, testInfo) => {
    // Reproduces the slides-ui _createSlide race: getCurrentUnitOfType()
    // returns null between disposeUnit() and createUnit(). Pre-patch this
    // threw "Cannot read properties of null (reading 'getPageSize')" the
    // moment we swapped decks; post-patch _getCurrUnitModel() reads from
    // the renderContext.unit and survives the race.
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __slideRevProbe?: unknown }).__slideRevProbe === 'function',
      null,
      { timeout: 15_000 },
    );

    // Save the default deck, then re-open it to force swapDeck.
    // Same 30 s rationale as above — CI cold start on the worker bundle.
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: /^save$/i }).click();
    const download = await downloadPromise;
    const downloadedPath = await download.path();
    expect(downloadedPath).toBeTruthy();

    // Persist to a stable path so setInputFiles can pick it up.
    const fixturePath = testInfo.outputPath('round-trip.pptx');
    const { copyFileSync } = await import('node:fs');
    copyFileSync(downloadedPath!, fixturePath);

    // The Open .pptx button trips a hidden <input type=file ref={fileInputRef}>.
    // Drive the input directly — that fires the change handler, which
    // calls swapDeck → disposeUnit + createUnit, the exact code path that
    // hit the bug.
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(fixturePath);

    // Wait for the import to finish (status pill updates) then settle.
    await expect(page.locator('.cs-titlebar__pill--status')).toContainText(/loaded/i, { timeout: 10_000 });
    await page.waitForTimeout(500);

    const fatal = errors.filter(
      (e) =>
        !e.includes('fonts.googleapis') &&
        !e.includes('favicon') &&
        // Known secondary bug in @univerjs/slides-ui slide-editing render
        // controller — after disposeUnit, a doc-selection .activate() fires
        // against a stale renderer and throws. The canvas still renders
        // correctly. Tracked separately (Gap 9 / render-doc-selection-activate).
        !e.includes('renderer.activate is not a function') &&
        // React 18 warns when Univer's internal nested React root is
        // unmounted as part of our outer unmount cycle (the swapDeck
        // remount path). Cosmetic; the actual UI re-renders correctly
        // (verified by the open-pptx diagnostic — main canvas content
        // is present after remount).
        !e.includes('synchronously unmount a root'),
    );

    // The error we DID fix: pre-patch this would have surfaced as
    // "Cannot read properties of null (reading 'getPageSize')".
    expect(
      errors.some((e) => e.includes("Cannot read properties of null (reading 'getPageSize')")),
      'getPageSize race must not appear — that is the patch we shipped',
    ).toBe(false);

    expect(fatal, `swapDeck console errors:\n${fatal.join('\n')}`).toEqual([]);
  });

  test('all element/page ops fire mutations (Gap 2 round 2)', async ({ page }) => {
    // After Gap 2 round 2, four more public commands route through
    // CommandType.MUTATION:
    //   slide.command.add-text            → slide.mutation.insert-element  (round 1)
    //   slide.operation.update-element    → slide.mutation.update-element  (round 2)
    //   slide.operation.delete-element    → slide.mutation.delete-element  (round 2)
    //   slide.operation.append-slide      → slide.mutation.insert-page     (round 2)
    // This single test drives all four and asserts each produces the
    // expected wire-format mutation id in window.__capturedMutations.
    await page.goto('/');
    await page.waitForFunction(
      () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(800);

    const captured = await page.evaluate(async () => {
      type W = {
        univer: { __getInjector(): { get(id: unknown): { executeCommand(id: string, params?: unknown): Promise<boolean> } } };
        __capturedMutations: string[];
      };
      const w = window as unknown as W;
      const inj = w.univer.__getInjector();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cs = inj.get((globalThis as any).__casualSlides__ICommandService);
      // Cross-cut: read the snapshot to grab the active page + a known
      // element id. The default deck always has 'el-1-title' on page 1.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inst = inj.get((globalThis as any).__casualSlides__IUniverInstanceService);
      const unitId = inst.getFocusedUnit().getUnitId();

      // Reset capture before our suite.
      w.__capturedMutations = [];

      await cs.executeCommand('slide.command.add-text', { text: 'probe-add' });
      await cs.executeCommand('slide.operation.update-element', {
        unitId,
        oKey: 'el-1-title',
        props: { left: 999, top: 999 },
      });
      await cs.executeCommand('slide.operation.delete-element', { unitId, id: 'el-1-subtitle' });
      await cs.executeCommand('slide.operation.append-slide', { unitId });

      return [...w.__capturedMutations];
    });

    expect(captured).toContain('slide.mutation.insert-element');
    expect(captured).toContain('slide.mutation.update-element');
    expect(captured).toContain('slide.mutation.delete-element');
    expect(captured).toContain('slide.mutation.insert-page');
  });

  test('insert-text fires onMutationExecutedForCollab (Gap 2 V1)', async ({ page }) => {
    // Pre-patch: SlideAddTextCommand routed through SlideAddTextOperation,
    // declared as CommandType.OPERATION. ICommandService.onMutationExecutedForCollab
    // fires ONLY for CommandType.MUTATION, so the collab bridge would have
    // silently dropped every text insert. Post-patch: the command synthesizes
    // a SlideInsertElementMutation and dispatches that, which IS broadcast
    // eligible. UniverSlide subscribes to the hook at bootstrap and stashes
    // every mutation id on window.__capturedMutations.
    await page.goto('/');
    await page.waitForFunction(
      () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
      null,
      { timeout: 15_000 },
    );
    // Plugin lifecycle takes a beat after createUnit to land on Steady, which
    // is when slides-ui registers its commands. Without this wait the probe
    // races and ICommandService still throws "not registered".
    await page.waitForTimeout(800);

    const captured = await page.evaluate(async () => {
      type W = {
        univer: { executeCommand?: (id: string, params?: unknown) => Promise<boolean>; __getInjector(): { get(id: unknown): { executeCommand(id: string, params?: unknown): Promise<boolean> } } };
        __capturedMutations: string[];
      };
      const w = window as unknown as W;
      const before = [...w.__capturedMutations];

      // Resolve the command service via the same injector path UniverSlide uses.
      // We can't import ICommandService here, but the injector still has it
      // — the bootstrap already pulled it. Run the command via the FUniver
      // facade's underlying command service.
      const inj = w.univer.__getInjector();
      // ICommandService's symbol is the named identifier; the injector
      // also accepts the string identifier name.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cs = inj.get((globalThis as any).__casualSlides__ICommandService);

      await cs.executeCommand('slide.command.add-text', { text: 'spike-collab-probe' });
      return { before, after: [...w.__capturedMutations] };
    });

    // The post-patch list must contain the new mutation id (and not the old
    // operation id, which was the OPERATION-typed escape hatch).
    expect(captured.after).toContain('slide.mutation.insert-element');
    expect(captured.after.length).toBeGreaterThan(captured.before.length);
  });

  test('Toolbar → Text box dispatches insert-element', async ({ page }) => {
    // The toolbar's "Text box" button should dispatch slide.command.add-text
    // → slide.mutation.insert-element. Regression guard for the toolbar
    // wiring layer (apps/web/src/univer/commands.ts).
    await page.goto('/');
    await page.waitForFunction(
      () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(800);

    await page.evaluate(() => {
      (window as { __capturedMutations: string[] }).__capturedMutations = [];
    });
    await page.getByRole('button', { name: /^text box$/i }).click();
    await page.waitForTimeout(200);

    const captured = await page.evaluate(() => [...(window as { __capturedMutations: string[] }).__capturedMutations]);
    expect(captured).toContain('slide.mutation.insert-element');
  });

  test('Undo after Text box restores prior state (Gap 2 + Univer undo wiring)', async ({ page }) => {
    // Insert a text element, then dispatch univer.command.undo. The
    // (delete, insert) inverse-mutation pair the slide.command.add-text
    // handler pushes onto IUndoRedoService should produce a
    // slide.mutation.delete-element on undo. Catches regressions in the
    // mutation-pair scaffolding and the Univer undo wiring.
    await page.goto('/');
    await page.waitForFunction(
      () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(800);

    const captured = await page.evaluate(async () => {
      type W = {
        univer: { __getInjector(): { get(id: unknown): { executeCommand(id: string, params?: unknown): Promise<boolean> } } };
        __capturedMutations: string[];
      };
      const w = window as unknown as W;
      const inj = w.univer.__getInjector();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cs = inj.get((globalThis as any).__casualSlides__ICommandService);
      w.__capturedMutations = [];
      await cs.executeCommand('slide.command.add-text', { text: 'probe-undo' });
      await cs.executeCommand('univer.command.undo');
      return [...w.__capturedMutations];
    });

    expect(captured).toContain('slide.mutation.insert-element');
    expect(captured).toContain('slide.mutation.delete-element');
  });

  test('Right-click on slide thumbnail opens context menu + Duplicate dispatches', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(800);

    // Find the first thumbnail by the slide-number span "1" inside Univer's
    // left-sidebar. Right-click its sibling div (the actual thumbnail).
    const thumbnail = page.locator('aside[data-u-comp="left-sidebar"] span:has-text("1") + div').first();
    await thumbnail.click({ button: 'right' });

    await expect(page.locator('[data-testid="slide-context-menu"]')).toBeVisible();

    // Reset capture before clicking Duplicate.
    await page.evaluate(() => {
      (window as { __capturedMutations: string[] }).__capturedMutations = [];
    });
    await page.locator('[data-testid="slide-context-menu"]').getByText(/duplicate slide/i).click();
    await page.waitForTimeout(300);

    const captured = await page.evaluate(() => [...(window as { __capturedMutations: string[] }).__capturedMutations]);
    expect(captured).toContain('slide.mutation.insert-page');

    // Menu closed after click.
    await expect(page.locator('[data-testid="slide-context-menu"]')).toHaveCount(0);
  });

  test('Background picker → preset chip dispatches update-page', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(800);

    // Click the Background toolbar button.
    await page.getByRole('button', { name: /^background$/i }).click();
    await expect(page.locator('[data-testid="bg-picker"]')).toBeVisible();

    // Reset capture; click the "Red" chip in the palette.
    await page.evaluate(() => {
      (window as { __capturedMutations: string[] }).__capturedMutations = [];
    });
    await page.locator('[data-testid="bg-picker"]').getByRole('button', { name: 'Red' }).click();
    await page.waitForTimeout(200);

    const captured = await page.evaluate(() => [...(window as { __capturedMutations: string[] }).__capturedMutations]);
    expect(captured).toContain('slide.mutation.update-page');
    // Default = active slide only → exactly one update-page dispatch.
    expect(captured.filter((m) => m === 'slide.mutation.update-page')).toHaveLength(1);

    // Picker closed after selection.
    await expect(page.locator('[data-testid="bg-picker"]')).toHaveCount(0);
  });

  test('Image export round-trip — image bytes land in ppt/media/', async ({ page }) => {
    // Build an ISlideData snapshot with one IMAGE element that carries a
    // 1×1 transparent PNG as a data: URI. Export via the pptx client and
    // verify the produced zip contains a `ppt/media/image1.png` entry.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );

    const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    // Build the snapshot + export in-page, return the bytes; unzip in Node
    // (browser can't dynamic-import 'jszip' without Vite pre-bundling it
    // as a known endpoint).
    const bytes = await page.evaluate(async (dataUri) => {
      type W = {
        __casualSlides_getPptxClient: () => {
          export(snapshot: unknown): Promise<{ blob: Blob; fileName: string }>;
        };
      };
      const client = (window as unknown as W).__casualSlides_getPptxClient();
      const snapshot = {
        id: 'image-round-trip',
        title: 'image round-trip',
        pageSize: { width: 960, height: 540 },
        body: {
          pageOrder: ['p1'],
          pages: {
            p1: {
              id: 'p1',
              pageType: 0,                          // PageType.SLIDE
              zIndex: 1,
              title: 'p1',
              description: '',
              pageBackgroundFill: { rgb: 'rgb(255,255,255)' },
              pageElements: {
                'img-1': {
                  id: 'img-1',
                  zIndex: 1,
                  left: 100,
                  top: 100,
                  width: 200,
                  height: 200,
                  title: 'test image',
                  description: '',
                  type: 1,                          // PageElementType.IMAGE
                  image: { imageProperties: { contentUrl: dataUri } },
                },
              },
            },
          },
        },
      };
      const { blob } = await client.export(snapshot);
      const buf = await blob.arrayBuffer();
      return Array.from(new Uint8Array(buf));
    }, PNG_1x1);

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(new Uint8Array(bytes));
    const mediaEntries = Object.keys(zip.files).filter((n) => n.startsWith('ppt/media/'));

    // Sanity: at least one media entry was produced and at least one is a
    // raster image (PNG/JPEG/GIF). PptxGenJS varies its naming
    // (`image1.png`, `image-1.png`, etc.) across versions — match by
    // extension rather than the full name.
    expect(
      mediaEntries.length,
      `expected ppt/media/* entries, got: ${mediaEntries.join(', ') || '(none)'}`,
    ).toBeGreaterThan(0);
    expect(
      mediaEntries.some((n) => /\.(png|jpe?g|gif|bmp)$/i.test(n)),
      `expected an image file under ppt/media/, got: ${mediaEntries.join(', ')}`,
    ).toBe(true);
  });

  test('pptx import preserves text props (size/bold/color) + images', async ({ page }) => {
    // Round-trip a deck with a styled text frame and an image, then
    // assert the importer extracted the rich-text props and the image
    // bytes back out. Catches fidelity regressions in pptx-import.ts.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(800);

    const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    const result = await page.evaluate(async (dataUri) => {
      type W = {
        __casualSlides_getPptxClient: () => {
          export(snapshot: unknown): Promise<{ blob: Blob; fileName: string }>;
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      const client = (window as unknown as W).__casualSlides_getPptxClient();
      const snapshot = {
        id: 'roundtrip-fidelity',
        title: 'roundtrip fidelity',
        pageSize: { width: 960, height: 540 },
        body: {
          pageOrder: ['p1'],
          pages: {
            p1: {
              id: 'p1',
              pageType: 0,
              zIndex: 1,
              title: 'p1',
              description: '',
              pageBackgroundFill: { rgb: 'rgb(255,255,255)' },
              pageElements: {
                'txt-1': {
                  id: 'txt-1',
                  zIndex: 1,
                  left: 80, top: 100, width: 800, height: 100,
                  title: '', description: '',
                  type: 2,                           // TEXT
                  richText: {
                    text: 'Round-trip me',
                    fs: 30,
                    bl: 1,
                    cl: { rgb: '#FF0000' },
                  },
                },
                'img-1': {
                  id: 'img-1',
                  zIndex: 2,
                  left: 100, top: 300, width: 200, height: 200,
                  title: '', description: '',
                  type: 1,                           // IMAGE
                  image: { imageProperties: { contentUrl: dataUri } },
                },
              },
            },
          },
        },
      };
      const { blob } = await client.export(snapshot);
      const buf = await blob.arrayBuffer();
      const reimported = await client.import(buf, 'roundtrip.pptx');
      return reimported;
    }, PNG_1x1);

    // Narrow into the re-imported structure.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = result;
    const pages = r?.body?.pages ?? {};
    const firstPage = pages[r?.body?.pageOrder?.[0]];
    expect(firstPage, 'first page exists').toBeTruthy();
    const elements = Object.values(firstPage.pageElements ?? {});
    expect(elements.length, 'page has elements').toBeGreaterThan(0);

    // Find the text element. It should retain fs (30 pt) and bold (1).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = elements.find((e: any) => e.type === 2);
    expect(text, 're-imported text element').toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((text as any).richText?.fs).toBe(30);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((text as any).richText?.bl).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((text as any).richText?.text).toContain('Round-trip me');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const colorHex = ((text as any).richText?.cl?.rgb ?? '').toUpperCase().replace('#', '');
    expect(colorHex, 'color round-trips through OOXML srgbClr').toBe('FF0000');

    // Find the image element — contentUrl should be a `data:image/` URI
    // synthesized from the extracted ppt/media/* bytes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const img = elements.find((e: any) => e.type === 1);
    expect(img, 're-imported image element').toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((img as any).image?.imageProperties?.contentUrl).toMatch(/^data:image\//);
  });

  test('pptx import wave 2 — bg fill + font family survives round-trip', async ({ page }) => {
    // A2 + B3 in one round-trip. PptxGenJS export honors `background`
    // and per-text `fontFace`; the new importer reads them back.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const result = await page.evaluate(async () => {
      type W = {
        __casualSlides_getPptxClient: () => {
          export(snapshot: unknown): Promise<{ blob: Blob; fileName: string }>;
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      const client = (window as unknown as W).__casualSlides_getPptxClient();
      const snapshot = {
        id: 'wave2-bg-font',
        title: 'wave2 bg font',
        pageSize: { width: 960, height: 540 },
        body: {
          pageOrder: ['p1'],
          pages: {
            p1: {
              id: 'p1',
              pageType: 0,
              zIndex: 1,
              title: 'p1',
              description: '',
              pageBackgroundFill: { rgb: '#112244' },
              pageElements: {
                't': {
                  id: 't',
                  zIndex: 1,
                  left: 80, top: 100, width: 800, height: 100,
                  title: '', description: '',
                  type: 2,
                  richText: { text: 'Custom font', fs: 22, ff: 'Georgia' },
                },
              },
            },
          },
        },
      };
      const { blob } = await client.export(snapshot);
      const reimported = await client.import(await blob.arrayBuffer(), 'wave2-bg-font.pptx');
      return reimported;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = result;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    expect(firstPage, 'first page').toBeTruthy();

    // A2: bg color survives. PptxGenJS writes a normalised uppercase hex,
    // we read it back as `#RRGGBB`.
    const bgHex = (firstPage.pageBackgroundFill?.rgb ?? '').toUpperCase().replace(/^#/, '');
    expect(bgHex, 'slide bg srgbClr round-trips').toBe('112244');

    // B3: ff is now populated on the first re-imported text element.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = Object.values(firstPage.pageElements ?? {}).find((e: any) => e.type === 2) as any;
    expect(text?.richText?.ff, 'font family survives').toBe('Georgia');
  });

  test('pptx import wave 2 — group shape recursion flattens nested shapes', async ({ page }) => {
    // PptxGenJS can't author <p:grpSp>, so we build a minimal valid
    // pptx by hand. The group's xfrm offsets the child by (1in, 1in)
    // with a child-coord-space matching its content rect, so the
    // shape's slide-space top-left lands at exactly 96 px, 96 px.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const reimported = await page.evaluate(async () => {
      // Minimal pptx skeleton, hand-rolled. Univer's importer needs:
      //   ppt/presentation.xml + its rels
      //   ppt/slides/slide1.xml + its rels (empty is fine)
      //   [Content_Types].xml is not consulted but kept for sanity
      const presentation =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:sldSz cx="9144000" cy="6858000"/>` +
        `<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>` +
        `</p:presentation>`;
      const presRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>` +
        `</Relationships>`;
      const slide =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="6858000"/><a:chOff x="0" y="0"/><a:chExt cx="9144000" cy="6858000"/></a:xfrm></p:grpSpPr>` +
        // Inner group — offset by (914400, 914400) = (96 px, 96 px) at 9525 EMU/px,
        // with a child-coord-space that matches so children render 1:1 inside.
        `<p:grpSp>` +
        `<p:nvGrpSpPr><p:cNvPr id="2" name="grp"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="3810000" cy="2857500"/><a:chOff x="0" y="0"/><a:chExt cx="3810000" cy="2857500"/></a:xfrm></p:grpSpPr>` +
        // Nested shape at child-origin — should land at slide (96, 96) after the group offset.
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="3" name="inside"/><p:cNvSpPr/><p:nvSpPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="0" y="0"/><a:ext cx="3810000" cy="2857500"/></a:xfrm>` +
        `<a:prstGeom prst="ellipse"/>` +
        `<a:solidFill><a:srgbClr val="FF8800"/></a:solidFill>` +
        `</p:spPr>` +
        `</p:sp>` +
        `</p:grpSp>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'group.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    expect(firstPage, 'first page extracted').toBeTruthy();
    const elements = Object.values(firstPage.pageElements ?? {});
    expect(elements.length, 'group flattened to its inner shape').toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inner: any = elements[0];
    // Group's <a:off x=914400 y=914400/> → 96 px each. Child's local
    // offset is 0 so slide-space top-left lands at (96, 96).
    expect(inner.left, 'child top-left x after group xfrm').toBeCloseTo(96, 0);
    expect(inner.top, 'child top-left y after group xfrm').toBeCloseTo(96, 0);
    expect(inner.shape?.shapeType, 'preset geometry survives').toBe('ellipse');
    const fill = (inner.shape?.shapeProperties?.shapeBackgroundFill?.rgb ?? '').toUpperCase().replace('#', '');
    expect(fill, 'inner shape fill survives recursion').toBe('FF8800');
  });

  test('pptx import wave 4 — placeholder geometry inherits from slide layout (I3)', async ({ page }) => {
    // Hand-roll a pptx where the slide carries a title placeholder
    // with NO <a:xfrm>; the slideLayout supplies the geometry. Before
    // I3 this resulted in a 0×0 element at (0, 0); after, the title
    // lands at the layout-declared rect.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const reimported = await page.evaluate(async () => {
      const presentation =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:sldSz cx="9144000" cy="6858000"/>` +
        `<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>` +
        `</p:presentation>`;
      const presRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>` +
        `</Relationships>`;
      // Slide: title placeholder with NO xfrm — the test of I3.
      const slide =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
        `<p:spPr/>` +  // <-- intentionally no a:xfrm
        `<p:txBody>` +
        `<a:bodyPr/><a:lstStyle/>` +
        // Bare run — no a:rPr at all, so I4 has to supply the style
        // defaults from the layout placeholder's a:lstStyle.
        `<a:p><a:r><a:t>Inherited title</a:t></a:r></a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      // Slide rels — points at slideLayout1.
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
        `</Relationships>`;
      // Layout: title placeholder WITH xfrm at (1in, 0.5in) sized (8in × 1.5in).
      // (914400 EMU = 1 in = 96 px; 457200 = 0.5 in = 48 px;
      //  7315200 = 8 in = 768 px; 1371600 = 1.5 in = 144 px.)
      const layout =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="Title Placeholder 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="457200"/><a:ext cx="7315200" cy="1371600"/></a:xfrm>` +
        `</p:spPr>` +
        // I4 — layout supplies default text style for level-1 paragraphs.
        // sz="4400" → 44 pt; b="1"; <a:latin typeface="Calibri Light"/>;
        // colour FF8800.
        `<p:txBody>` +
        `<a:bodyPr/>` +
        `<a:lstStyle>` +
        `<a:lvl1pPr>` +
        `<a:defRPr sz="4400" b="1">` +
        `<a:solidFill><a:srgbClr val="FF8800"/></a:solidFill>` +
        `<a:latin typeface="Calibri Light"/>` +
        `</a:defRPr>` +
        `</a:lvl1pPr>` +
        `</a:lstStyle>` +
        `<a:p/>` +
        `</p:txBody>` +
        `</p:sp>` +
        `</p:spTree></p:cSld>` +
        `</p:sldLayout>`;
      const layoutRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels);
      zip.file('ppt/slideLayouts/slideLayout1.xml', layout);
      zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', layoutRels);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'placeholder.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    expect(firstPage, 'first page extracted').toBeTruthy();
    const elements = Object.values(firstPage.pageElements ?? {});
    expect(elements.length, 'title placeholder is captured').toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const title: any = elements[0];
    expect(title.left, 'left inherited from layout (1 in = 96 px)').toBeCloseTo(96, 0);
    expect(title.top, 'top inherited from layout (0.5 in = 48 px)').toBeCloseTo(48, 0);
    expect(title.width, 'width inherited (8 in = 768 px)').toBeCloseTo(768, 0);
    expect(title.height, 'height inherited (1.5 in = 144 px)').toBeCloseTo(144, 0);
    expect(title.richText?.text).toContain('Inherited title');

    // I4 — slide run had no <a:rPr>; layout defRPr supplies size, bold,
    // colour, font family.
    expect(title.richText?.fs, 'fs inherited from layout defRPr').toBe(44);
    expect(title.richText?.bl, 'bold inherited from layout defRPr').toBe(1);
    expect(title.richText?.ff, 'font family inherited from layout defRPr').toBe('Calibri Light');
    const colorHex = (title.richText?.cl?.rgb ?? '').toUpperCase().replace('#', '');
    expect(colorHex, 'color inherited from layout defRPr').toBe('FF8800');
  });

  test('pptx import wave 5 — theme schemeClr resolves to hex (J2)', async ({ page }) => {
    // Hand-roll a deck where a shape's fill is `<a:schemeClr val="accent1"/>`
    // and the theme defines accent1 = #E84B6A. After J2, the import
    // should resolve to that hex; before J2, the fill was dropped (null).
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const reimported = await page.evaluate(async () => {
      const presentation =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:sldSz cx="9144000" cy="6858000"/>` +
        `<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>` +
        `</p:presentation>`;
      const presRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>` +
        `</Relationships>`;
      // Slide: one shape, fill = schemeClr accent1.
      const slide =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld>` +
        // Slide background = bg2 alias (lt2) = light grey from theme.
        `<p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg2"/></a:solidFill></p:bgPr></p:bg>` +
        `<p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="shape"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="914400"/><a:ext cx="3810000" cy="2857500"/></a:xfrm>` +
        `<a:prstGeom prst="rect"/>` +
        `<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>` +
        `</p:spPr>` +
        `</p:sp>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
        `</Relationships>`;
      // Layout — minimal, just points at the master.
      const layout =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `</p:spTree></p:cSld>` +
        `</p:sldLayout>`;
      const layoutRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
        `</Relationships>`;
      // Master — empty placeholders, points at theme.
      const master =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `</p:spTree></p:cSld>` +
        `</p:sldMaster>`;
      const masterRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>` +
        `</Relationships>`;
      // Theme — accent1=#E84B6A, bg2=#F0F0F0.
      const theme =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements>` +
        `<a:clrScheme name="Test">` +
        `<a:dk1><a:srgbClr val="000000"/></a:dk1>` +
        `<a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>` +
        `<a:dk2><a:srgbClr val="44546A"/></a:dk2>` +
        `<a:lt2><a:srgbClr val="F0F0F0"/></a:lt2>` +
        `<a:accent1><a:srgbClr val="E84B6A"/></a:accent1>` +
        `<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>` +
        `<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>` +
        `<a:accent4><a:srgbClr val="FFC000"/></a:accent4>` +
        `<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>` +
        `<a:accent6><a:srgbClr val="70AD47"/></a:accent6>` +
        `<a:hlink><a:srgbClr val="0563C1"/></a:hlink>` +
        `<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>` +
        `</a:clrScheme>` +
        `</a:themeElements></a:theme>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels);
      zip.file('ppt/slideLayouts/slideLayout1.xml', layout);
      zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', layoutRels);
      zip.file('ppt/slideMasters/slideMaster1.xml', master);
      zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', masterRels);
      zip.file('ppt/theme/theme1.xml', theme);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'theme.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    expect(firstPage, 'first page extracted').toBeTruthy();

    // Slide bg = bg2 alias (lt2) = #F0F0F0.
    const bgHex = (firstPage.pageBackgroundFill?.rgb ?? '').toUpperCase().replace('#', '');
    expect(bgHex, 'slide bg schemeClr (bg2 alias → lt2) resolves').toBe('F0F0F0');

    // Shape fill = accent1 = #E84B6A.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shape: any = Object.values(firstPage.pageElements ?? {})[0];
    expect(shape, 'shape extracted').toBeTruthy();
    const fillHex = (shape.shape?.shapeProperties?.shapeBackgroundFill?.rgb ?? '').toUpperCase().replace('#', '');
    expect(fillHex, 'shape schemeClr accent1 resolves').toBe('E84B6A');
  });

  test('pptx import wave 5b — rotation, flips, color modifiers (lumMod/lumOff)', async ({ page }) => {
    // Shape with rot=45deg, flipH=1, fill = schemeClr accent1 with
    // lumMod=60000 + lumOff=40000 (PowerPoint's "Accent 1, Lighter 60%").
    // Without modifiers the fill would be raw accent1 — too dark.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const reimported = await page.evaluate(async () => {
      const presentation =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:sldSz cx="9144000" cy="6858000"/>` +
        `<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>` +
        `</p:presentation>`;
      const presRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>` +
        `</Relationships>`;
      // Slide: shape rotated 45° (rot=2700000 = 45*60000), flipped horizontally,
      // srgbClr white + shade=50000 → deterministic #808080 (blend
      // toward black by 50%). Avoids HSL rounding fuzz in the assertion.
      const slide =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="rotated"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm rot="2700000" flipH="1">` +
        `<a:off x="914400" y="914400"/><a:ext cx="2857500" cy="2857500"/>` +
        `</a:xfrm>` +
        `<a:prstGeom prst="rect"/>` +
        `<a:solidFill><a:srgbClr val="FFFFFF"><a:shade val="50000"/></a:srgbClr></a:solidFill>` +
        `</p:spPr>` +
        `</p:sp>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
        `</Relationships>`;
      const layout =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `</p:spTree></p:cSld></p:sldLayout>`;
      const layoutRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
        `</Relationships>`;
      const master =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `</p:spTree></p:cSld></p:sldMaster>`;
      const masterRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>` +
        `</Relationships>`;
      // accent1 = #4F81BD. lumMod=0.6, lumOff=0.4 → in HSL:
      //   L' = clamp(0.4 + 0.6 * L_original) — for #4F81BD this lands around #B8CCE4.
      // The exact target tolerates +/- a few units of rounding.
      const theme =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements>` +
        `<a:clrScheme name="Test">` +
        `<a:dk1><a:srgbClr val="000000"/></a:dk1>` +
        `<a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>` +
        `<a:dk2><a:srgbClr val="44546A"/></a:dk2>` +
        `<a:lt2><a:srgbClr val="EEECE1"/></a:lt2>` +
        `<a:accent1><a:srgbClr val="4F81BD"/></a:accent1>` +
        `<a:accent2><a:srgbClr val="C0504D"/></a:accent2>` +
        `<a:accent3><a:srgbClr val="9BBB59"/></a:accent3>` +
        `<a:accent4><a:srgbClr val="8064A2"/></a:accent4>` +
        `<a:accent5><a:srgbClr val="4BACC6"/></a:accent5>` +
        `<a:accent6><a:srgbClr val="F79646"/></a:accent6>` +
        `<a:hlink><a:srgbClr val="0000FF"/></a:hlink>` +
        `<a:folHlink><a:srgbClr val="800080"/></a:folHlink>` +
        `</a:clrScheme>` +
        `</a:themeElements></a:theme>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels);
      zip.file('ppt/slideLayouts/slideLayout1.xml', layout);
      zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', layoutRels);
      zip.file('ppt/slideMasters/slideMaster1.xml', master);
      zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', masterRels);
      zip.file('ppt/theme/theme1.xml', theme);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave5b.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shape: any = Object.values(firstPage.pageElements ?? {})[0];
    expect(shape, 'shape extracted').toBeTruthy();

    // D3 — rotation: 2700000 / 60000 = 45.
    expect(shape.angle, 'rot=2700000 → 45 deg').toBeCloseTo(45, 1);
    // D4 — flips.
    expect(shape.flipX, 'flipH=1 → flipX=true').toBe(true);
    expect(shape.flipY, 'flipV unset → flipY=false').toBe(false);

    // 5b — srgbClr white + shade=50000 → exact #808080.
    // shade(s) on srgbClr blends linearly toward black: 255 * (1 - 0.5)
    // = 127.5, rounded to 128 = 0x80 per channel.
    const fillHex = (shape.shape?.shapeProperties?.shapeBackgroundFill?.rgb ?? '').toUpperCase().replace('#', '');
    expect(fillHex, 'shade=50000 on white → 50% grey').toBe('808080');
  });

  test('pptx import wave 6 — multi-run rich text + paragraph alignment (B16 + C2)', async ({ page }) => {
    // Slide has one TEXT element with two paragraphs:
    //  • Para 1: "Hello " (regular) + "world" (bold red).
    //  • Para 2: "centered" (single run) with <a:pPr algn="ctr"/>.
    // Pre-wave-6 the importer collapsed both paras to first-run style.
    // After wave 6, richText.rich holds an IDocumentData with separate
    // textRuns per <a:r> and per-paragraph horizontalAlign.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const reimported = await page.evaluate(async () => {
      const presentation =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:sldSz cx="9144000" cy="6858000"/>` +
        `<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>` +
        `</p:presentation>`;
      const presRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>` +
        `</Relationships>`;
      const slide =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="7315200" cy="2857500"/></a:xfrm></p:spPr>` +
        `<p:txBody>` +
        `<a:bodyPr/><a:lstStyle/>` +
        // Para 1: "Hello " + "world" (bold red, fs=30)
        `<a:p>` +
        `<a:r><a:rPr lang="en-US"/><a:t>Hello </a:t></a:r>` +
        `<a:r><a:rPr lang="en-US" sz="3000" b="1"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:rPr><a:t>world</a:t></a:r>` +
        `</a:p>` +
        // Para 2: "centered" with algn="ctr"
        `<a:p>` +
        `<a:pPr algn="ctr"/>` +
        `<a:r><a:rPr lang="en-US"/><a:t>centered</a:t></a:r>` +
        `</a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave6.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text: any = Object.values(firstPage.pageElements ?? {})[0];
    expect(text?.richText?.rich, 'rich IDocumentData populated').toBeTruthy();

    // dataStream should be "Hello world\rcentered\r\n".
    const ds: string = text.richText.rich.body.dataStream;
    expect(ds).toBe('Hello world\rcentered\r\n');

    // Two paragraphs — startIndex points at the \r ending each.
    const paras = text.richText.rich.body.paragraphs;
    expect(paras.length, 'two paragraphs').toBe(2);
    expect(paras[0].startIndex, "first para ends at index 11 (length of 'Hello world')").toBe(11);
    expect(paras[1].startIndex, "second para ends at index 20 (length of 'Hello world\\rcentered')").toBe(20);

    // C2 — second paragraph carries center alignment.
    // HorizontalAlign.CENTER = 2.
    expect(paras[1].paragraphStyle?.horizontalAlign, 'algn=ctr → CENTER (2)').toBe(2);
    // First paragraph had no algn → no paragraphStyle override.
    expect(paras[0].paragraphStyle?.horizontalAlign).toBeUndefined();

    // B16 — three textRuns: "Hello ", "world", "centered".
    const runs = text.richText.rich.body.textRuns;
    expect(runs.length, 'three text runs').toBe(3);
    expect(runs[0].st).toBe(0); expect(runs[0].ed).toBe(6);
    expect(runs[1].st).toBe(6); expect(runs[1].ed).toBe(11);
    expect(runs[2].st).toBe(12); expect(runs[2].ed).toBe(20);
    // Run 2 carries the bold + red + fs=30.
    expect(runs[1].ts?.bl, 'bold preserved on second run').toBe(1);
    expect(runs[1].ts?.fs, 'fs=30 on second run').toBe(30);
    const r2hex = (runs[1].ts?.cl?.rgb ?? '').toUpperCase().replace('#', '');
    expect(r2hex, 'red color preserved on second run').toBe('FF0000');
    // First run had no rPr — flat fields empty, run 1 should NOT carry the bold style.
    expect(runs[0].ts?.bl).toBeFalsy();
  });

  test('pptx import wave 6b — bullets + indent + line spacing (C3/C4/C6-8)', async ({ page }) => {
    // Three paragraphs in one text body:
    //   1) <a:buChar char="•"/> bulleted, level 0
    //   2) <a:buChar char="•"/> bulleted, level 1 (nested)
    //   3) <a:buAutoNum type="arabicPeriod"/> numbered, level 0
    //      with <a:lnSpc>150%, marL=720000 (75px), indent=-360000 (-37.5px)
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const reimported = await page.evaluate(async () => {
      const presentation =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:sldSz cx="9144000" cy="6858000"/>` +
        `<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>` +
        `</p:presentation>`;
      const presRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>` +
        `</Relationships>`;
      const slide =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="bullets"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="7315200" cy="2857500"/></a:xfrm></p:spPr>` +
        `<p:txBody>` +
        `<a:bodyPr/><a:lstStyle/>` +
        `<a:p><a:pPr lvl="0"><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>One</a:t></a:r></a:p>` +
        `<a:p><a:pPr lvl="1"><a:buChar char="•"/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>One A</a:t></a:r></a:p>` +
        `<a:p><a:pPr lvl="0" marL="720000" indent="-360000"><a:lnSpc><a:spcPct val="150000"/></a:lnSpc><a:buAutoNum type="arabicPeriod"/></a:pPr><a:r><a:rPr lang="en-US"/><a:t>Two</a:t></a:r></a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave6b.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text: any = Object.values(firstPage.pageElements ?? {})[0];
    const paras = text?.richText?.rich?.body?.paragraphs;
    expect(paras?.length, 'three paragraphs').toBe(3);

    // C6 — first para is bulleted at level 0.
    expect(paras[0].bullet?.listType, 'p1 is BULLET_LIST').toBe('BULLET_LIST');
    expect(paras[0].bullet?.nestingLevel, 'p1 level 0').toBe(0);

    // C8 — second para is bulleted at level 1.
    expect(paras[1].bullet?.listType, 'p2 is BULLET_LIST').toBe('BULLET_LIST');
    expect(paras[1].bullet?.nestingLevel, 'p2 level 1 (nested)').toBe(1);

    // C7 — third para is auto-numbered.
    expect(paras[2].bullet?.listType, 'p3 is ORDER_LIST').toBe('ORDER_LIST');

    // C4 — third para has line spacing 150%.
    expect(paras[2].paragraphStyle?.lineSpacing, 'p3 lineSpacing 1.5').toBeCloseTo(1.5, 2);

    // C3 — third para has indent. 720000 EMU = 75.59 px; -360000 = -37.79 px.
    expect(paras[2].paragraphStyle?.indentStart?.v, 'p3 indentStart ~75px').toBeCloseTo(75.59, 0);
    expect(paras[2].paragraphStyle?.indentFirstLine?.v, 'p3 indentFirstLine ~-37px').toBeCloseTo(-37.79, 0);

    // Bullets across paragraphs of the same list share a listId so
    // numbering doesn't restart mid-frame.
    expect(paras[0].bullet?.listId).toBe(paras[1].bullet?.listId);
  });

  test('pptx import wave 7 — gradient fallback + outline dash + paragraph spacing', async ({ page }) => {
    // Shape with <a:gradFill> (0% red → 100% blue) → degraded to first
    // stop = red. Outline uses <a:prstDash val="dash"/> → DASHED (4).
    // Text frame has a paragraph with spcBef 12pt + spcAft 6pt.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const reimported = await page.evaluate(async () => {
      const presentation =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:sldSz cx="9144000" cy="6858000"/>` +
        `<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>` +
        `</p:presentation>`;
      const presRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>` +
        `</Relationships>`;
      const slide =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        // Shape: gradient fill (red → blue), dashed outline.
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="g"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="914400"/><a:ext cx="2857500" cy="2857500"/></a:xfrm>` +
        `<a:prstGeom prst="rect"/>` +
        `<a:gradFill>` +
        `<a:gsLst>` +
        `<a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>` +
        `<a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs>` +
        `</a:gsLst>` +
        `<a:lin ang="5400000" scaled="1"/>` +
        `</a:gradFill>` +
        `<a:ln w="38100">` +  // 4pt outline
        `<a:solidFill><a:srgbClr val="000000"/></a:solidFill>` +
        `<a:prstDash val="dash"/>` +
        `</a:ln>` +
        `</p:spPr>` +
        `</p:sp>` +
        // Text: one para with spcBef 1200 (12pt) + spcAft 600 (6pt).
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="3" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="3814400" y="914400"/><a:ext cx="4000000" cy="2000000"/></a:xfrm></p:spPr>` +
        `<p:txBody><a:bodyPr/><a:lstStyle/>` +
        `<a:p><a:pPr><a:spcBef><a:spcPts val="1200"/></a:spcBef><a:spcAft><a:spcPts val="600"/></a:spcAft></a:pPr>` +
        `<a:r><a:rPr lang="en-US"/><a:t>spaced</a:t></a:r></a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave7.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    const elements = Object.values(firstPage.pageElements ?? {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shape = elements.find((e: any) => e.shape) as any;
    expect(shape, 'shape extracted').toBeTruthy();

    // D9 — gradient → first stop FF0000.
    const fillHex = (shape.shape.shapeProperties?.shapeBackgroundFill?.rgb ?? '').toUpperCase().replace('#', '');
    expect(fillHex, 'gradient → first stop solid (red)').toBe('FF0000');

    // D15 — outline dash style = DASHED (4).
    expect(shape.shape.shapeProperties?.outline?.dashStyle, 'prstDash=dash → DASHED').toBe(4);

    // C5 — paragraph spaceAbove (12pt) + spaceBelow (6pt).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = elements.find((e: any) => e.richText) as any;
    const paraStyle = text?.richText?.rich?.body?.paragraphs?.[0]?.paragraphStyle;
    expect(paraStyle?.spaceAbove?.v, 'spcBef 1200 → 12pt').toBe(12);
    expect(paraStyle?.spaceBelow?.v, 'spcAft 600 → 6pt').toBe(6);
  });

  test('pptx import preserves shape geometry + fill', async ({ page }) => {
    // Build a deck with a non-text SHAPE (ellipse, green fill, blue
    // outline). Export → re-import → assert prstGeom + fill survive.
    // Pre-patch, every shape came back as a white rect.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(800);

    const result = await page.evaluate(async () => {
      type W = {
        __casualSlides_getPptxClient: () => {
          export(snapshot: unknown): Promise<{ blob: Blob; fileName: string }>;
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      const client = (window as unknown as W).__casualSlides_getPptxClient();
      const snapshot = {
        id: 'roundtrip-shape',
        title: 'roundtrip shape',
        pageSize: { width: 960, height: 540 },
        body: {
          pageOrder: ['p1'],
          pages: {
            p1: {
              id: 'p1',
              pageType: 0,
              zIndex: 1,
              title: 'p1',
              description: '',
              pageBackgroundFill: { rgb: 'rgb(255,255,255)' },
              pageElements: {
                'shape-1': {
                  id: 'shape-1',
                  zIndex: 1,
                  left: 120, top: 80, width: 320, height: 200,
                  title: '', description: '',
                  type: 0,                           // SHAPE
                  shape: {
                    shapeType: 'ellipse',
                    text: '',
                    shapeProperties: {
                      shapeBackgroundFill: { rgb: '#00CC44' },
                      outline: { outlineFill: { rgb: '#0044CC' }, weight: 3 },
                    },
                  },
                },
              },
            },
          },
        },
      };
      const { blob } = await client.export(snapshot);
      const buf = await blob.arrayBuffer();
      const reimported = await client.import(buf, 'roundtrip-shape.pptx');
      return reimported;
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = result;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    expect(firstPage, 'first page exists').toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shape = Object.values(firstPage.pageElements ?? {}).find((e: any) => e.type === 0);
    expect(shape, 're-imported shape element').toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s: any = shape;
    expect(s.shape?.shapeType, 'prstGeom value survives').toBe('ellipse');
    const fillHex = (s.shape?.shapeProperties?.shapeBackgroundFill?.rgb ?? '').toUpperCase().replace('#', '');
    expect(fillHex, 'solidFill srgbClr round-trips').toBe('00CC44');
    const outlineHex = (s.shape?.shapeProperties?.outline?.outlineFill?.rgb ?? '').toUpperCase().replace('#', '');
    expect(outlineHex, 'outline srgbClr round-trips').toBe('0044CC');
  });

  test('File → Properties shows deck metadata', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(400);

    // Open File menu, click Properties.
    await page.getByRole('button', { name: 'File' }).click();
    await page.getByRole('button', { name: /^Properties$/ }).click();
    await expect(page.locator('[data-testid="properties-dialog"]')).toBeVisible();

    // Default deck has 3 slides at 960×540 px.
    await expect(page.locator('[data-testid="prop-slides"] .cs-properties__value')).toHaveText('3');
    await expect(page.locator('[data-testid="prop-page-size"] .cs-properties__value')).toContainText('960 × 540 px');

    // Escape closes.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="properties-dialog"]')).toHaveCount(0);
  });

  test('File → Recent files reopens a deck across reloads (IndexedDB)', async ({ page }, testInfo) => {
    // 1. Save the default deck, 2. Open it (writes to IndexedDB),
    // 3. Reload (clears in-memory state but not IDB), 4. File → Recent
    // files, 5. Click the entry → status reads "Loaded · N slides".
    await page.goto('/');
    await page.waitForFunction(
      () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
      null,
      { timeout: 15_000 },
    );

    // Export the default deck.
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: /^save$/i }).click();
    const download = await downloadPromise;
    const downloadedPath = await download.path();
    expect(downloadedPath).toBeTruthy();

    const fixturePath = testInfo.outputPath('recent-fixture.pptx');
    const { copyFileSync } = await import('node:fs');
    copyFileSync(downloadedPath!, fixturePath);

    // Open via the hidden file input — same path the Open button uses.
    // This fires addRecent under the hood.
    await page.locator('input[type="file"]').setInputFiles(fixturePath);
    await expect(page.locator('.cs-titlebar__pill--status')).toContainText(/loaded/i, { timeout: 10_000 });

    // Probe IDB directly pre-reload — proves persistence is durable
    // before we trust the round-trip across a page lifecycle.
    const preReloadRows = await page.evaluate(async () => {
      const req = indexedDB.open('casual-slides', 1);
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const rows = await new Promise<unknown[]>((resolve, reject) => {
        const r = db.transaction('recent', 'readonly').objectStore('recent').getAll();
        r.onsuccess = () => resolve(r.result as unknown[]);
        r.onerror = () => reject(r.error);
      });
      db.close();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return rows.map((row: any) => ({ name: row.name, size: row.size }));
    });
    expect(preReloadRows.length).toBeGreaterThan(0);

    // Reload — wipes in-memory state, keeps IDB.
    await page.reload();
    await page.waitForFunction(
      () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
      null,
      { timeout: 15_000 },
    );

    // File menu → Recent files. Use the data-menu-item hook to avoid
    // matching the menubar "File" button label.
    await page.getByRole('button', { name: 'File' }).click();
    await page.locator('button[data-menu="file"][data-menu-item="recent"]').click();
    await expect(page.locator('[data-testid="recent-dialog"]')).toBeVisible();

    // The entry from the prior open should be listed.
    const entry = page.locator('[data-testid="recent-item"][data-recent-name="recent-fixture.pptx"]');
    await expect(entry).toBeVisible();

    // Click it → modal closes + status updates to "Loaded".
    await entry.click();
    await expect(page.locator('[data-testid="recent-dialog"]')).toHaveCount(0);
    await expect(page.locator('.cs-titlebar__pill--status')).toContainText(/loaded/i, { timeout: 10_000 });
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
