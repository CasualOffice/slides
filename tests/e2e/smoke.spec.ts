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

  test('pptx import wave 8a — placeholder type-only key matches layout type+idx ph', async ({ page }) => {
    // Real templates frequently mix `<p:ph type="title"/>` (slide side,
    // no idx) with `<p:ph type="title" idx="0"/>` (layout side, with
    // idx). Pre-fix our exact-string match missed and the title landed
    // at 0,0 size 0. Post-fix `indexUnderAllKeys` stores the layout
    // rect under `title|0`, `title|`, and `|0` so the slide's lookup
    // for `title|` hits.
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
      // Slide ph carries only `type="title"`, NO idx.
      const slide =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
        `<p:spPr/>` +  // no xfrm
        `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Mismatched-key title</a:t></a:r></a:p></p:txBody>` +
        `</p:sp>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
        `</Relationships>`;
      // Layout ph carries `type="title" idx="0"` — DIFFERENT shape from slide.
      const layout =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="Title PH"/><p:cNvSpPr/><p:nvPr><p:ph type="title" idx="0"/></p:nvPr></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="7315200" cy="1371600"/></a:xfrm></p:spPr>` +
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
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'mismatch.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    const elements = Object.values(firstPage.pageElements ?? {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const title: any = elements[0];
    expect(title, 'title placeholder extracted').toBeTruthy();
    expect(title.left, 'inherited left despite key-shape mismatch').toBeCloseTo(96, 0);
    expect(title.top, 'inherited top despite key-shape mismatch').toBeCloseTo(48, 0);
    expect(title.width, 'inherited width').toBeCloseTo(768, 0);
    expect(title.height, 'inherited height').toBeCloseTo(144, 0);
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

  test('pptx import wave 7b — bodyPr insets + vertical anchor (C10 + C11)', async ({ page }) => {
    // Text frame with custom bodyPr insets and anchor="ctr".
    // lIns/tIns/rIns/bIns are EMU; anchor=ctr → VerticalAlign.MIDDLE (2).
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
      // bodyPr with lIns=457200 (48px), tIns=228600 (24px), rIns=914400
      // (96px), bIns=457200 (48px), anchor="ctr".
      const slide =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="4000000" cy="2000000"/></a:xfrm></p:spPr>` +
        `<p:txBody>` +
        `<a:bodyPr lIns="457200" tIns="228600" rIns="914400" bIns="457200" anchor="ctr"/>` +
        `<a:lstStyle/>` +
        `<a:p><a:r><a:rPr lang="en-US"/><a:t>centered</a:t></a:r></a:p>` +
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
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave7b.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text: any = Object.values(firstPage.pageElements ?? {})[0];
    const docStyle = text?.richText?.rich?.documentStyle;
    expect(docStyle, 'documentStyle populated from bodyPr').toBeTruthy();

    // C10 — insets in px (EMU / 9525).
    expect(docStyle.marginLeft, 'lIns=457200 → 48 px').toBeCloseTo(48, 0);
    expect(docStyle.marginTop, 'tIns=228600 → 24 px').toBeCloseTo(24, 0);
    expect(docStyle.marginRight, 'rIns=914400 → 96 px').toBeCloseTo(96, 0);
    expect(docStyle.marginBottom, 'bIns=457200 → 48 px').toBeCloseTo(48, 0);

    // C11 — anchor="ctr" → VerticalAlign.MIDDLE (2).
    expect(docStyle.renderConfig?.verticalAlign, 'anchor=ctr → MIDDLE (2)').toBe(2);
  });

  test('pptx import wave 7c — connectors + image crop (F3 + E3)', async ({ page }) => {
    // <p:cxnSp> connector (straight line) survives import as a SHAPE
    // with prstGeom=line. <p:pic> with <a:srcRect l/t/r/b> populates
    // image.cropProperties offsets (normalised 0..1).
    const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const reimported = await page.evaluate(async (png) => {
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
        // F3 — straight connector.
        `<p:cxnSp>` +
        `<p:nvCxnSpPr><p:cNvPr id="2" name="cxn1"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="914400"/><a:ext cx="3000000" cy="0"/></a:xfrm>` +
        `<a:prstGeom prst="line"/>` +
        `<a:ln w="19050"><a:solidFill><a:srgbClr val="333333"/></a:solidFill></a:ln>` +
        `</p:spPr>` +
        `</p:cxnSp>` +
        // E3 — pic with srcRect cropping 25% from the left and 10% from the bottom.
        `<p:pic>` +
        `<p:nvPicPr><p:cNvPr id="3" name="img"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
        `<p:blipFill>` +
        `<a:blip r:embed="rId1"/>` +
        `<a:srcRect l="25000" t="0" r="0" b="10000"/>` +
        `</p:blipFill>` +
        `<p:spPr><a:xfrm><a:off x="914400" y="2000000"/><a:ext cx="2000000" cy="1500000"/></a:xfrm></p:spPr>` +
        `</p:pic>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>` +
        `</Relationships>`;

      // Decode the base64 PNG into bytes for the zip.
      const binary = atob(png);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels);
      zip.file('ppt/media/image1.png', bytes);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave7c.pptx');
    }, PNG_1x1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    const elements = Object.values(firstPage.pageElements ?? {});

    // F3 — connector survives as a SHAPE with prstGeom=line.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cxn = elements.find((e: any) => e.shape?.shapeType === 'line') as any;
    expect(cxn, 'connector extracted as line shape').toBeTruthy();
    const outlineHex = (cxn.shape?.shapeProperties?.outline?.outlineFill?.rgb ?? '').toUpperCase().replace('#', '');
    expect(outlineHex, 'connector outline color').toBe('333333');

    // E3 — image carries cropProperties.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const img = elements.find((e: any) => e.image) as any;
    const crop = img?.image?.imageProperties?.cropProperties;
    expect(crop, 'cropProperties populated from srcRect').toBeTruthy();
    expect(crop.offsetLeft, 'l=25000 → 0.25').toBeCloseTo(0.25, 3);
    expect(crop.offsetTop, 't=0 → 0').toBe(0);
    expect(crop.offsetRight, 'r=0 → 0').toBe(0);
    expect(crop.offsetBottom, 'b=10000 → 0.1').toBeCloseTo(0.1, 3);
  });

  test('pptx import wave 7d — noFill + line bbox inflate + ea font fallback (D12 + F4 + B4)', async ({ page }) => {
    // D12 — <a:noFill/> survives as the TRANSPARENT_FILL sentinel.
    // F4 — line shape with cy=0 inflates to the outline weight so the
    //      stroke renders instead of being clipped to a zero-height bbox.
    // B4 — `<a:ea typeface="SimSun"/>` without `<a:latin>` populates the
    //      element's ff (CJK / complex-script fallback chain).
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
        // D12 — rect with explicit <a:noFill/>.
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="transparent"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="914400"/><a:ext cx="2000000" cy="1000000"/></a:xfrm>` +
        `<a:prstGeom prst="rect"/>` +
        `<a:noFill/>` +
        `<a:ln w="12700"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln>` +
        `</p:spPr>` +
        `</p:sp>` +
        // F4 — horizontal line: cy=0.
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="3" name="hline"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="3000000"/><a:ext cx="3000000" cy="0"/></a:xfrm>` +
        `<a:prstGeom prst="line"/>` +
        `<a:ln w="19050"><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></a:ln>` +
        `</p:spPr>` +
        `</p:sp>` +
        // B4 — text frame whose run declares only <a:ea typeface="SimSun"/>.
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="4" name="cjk"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="4000000"/><a:ext cx="3000000" cy="800000"/></a:xfrm>` +
        `<a:prstGeom prst="rect"/>` +
        `</p:spPr>` +
        `<p:txBody>` +
        `<a:bodyPr/>` +
        `<a:p>` +
        `<a:r><a:rPr lang="zh-CN" sz="2400"><a:ea typeface="SimSun"/></a:rPr><a:t>你好</a:t></a:r>` +
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
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave7d.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    const elements = Object.values(firstPage.pageElements ?? {});

    // D12 — the rect with <a:noFill/> carries the transparent sentinel.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transparent = elements.find((e: any) => e.shape?.shapeType === 'rect') as any;
    expect(transparent, 'noFill rect extracted').toBeTruthy();
    const fillRgb = (transparent.shape?.shapeProperties?.shapeBackgroundFill?.rgb ?? '').toLowerCase();
    expect(fillRgb, 'noFill → transparent sentinel').toMatch(/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/);

    // F4 — horizontal line's zero cy is inflated to the stroke width
    // (19050 EMU = 2 px) so the rendered bbox isn't clipped to nothing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hline = elements.find((e: any) => e.shape?.shapeType === 'line') as any;
    expect(hline, 'line shape extracted').toBeTruthy();
    expect(hline.height, 'line height inflated above 0').toBeGreaterThan(0);

    // B4 — the CJK run's ff falls through from <a:ea>.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cjk = elements.find((e: any) => e.richText && e.richText.text?.includes('你')) as any;
    expect(cjk, 'CJK text frame extracted').toBeTruthy();
    expect(cjk.richText.ff, '<a:ea typeface> populates ff').toBe('SimSun');
  });

  test('pptx import wave 7e — picture background synthesises IMAGE at z=0 (A4)', async ({ page }) => {
    // <p:bg><p:bgPr><a:blipFill><a:blip r:embed=…>` can't fit into
    // ISlidePage.pageBackgroundFill (IColorStyle), so the importer
    // synthesises an IMAGE element at z-index 0 covering the page
    // size — beneath authored content (which starts at z=1).
    const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const reimported = await page.evaluate(async (png) => {
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
        `<p:cSld>` +
        `<p:bg><p:bgPr>` +
        `<a:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>` +
        `</p:bgPr></p:bg>` +
        `<p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>` +
        `</Relationships>`;

      const binary = atob(png);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels);
      zip.file('ppt/media/image1.png', bytes);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave7e.pptx');
    }, PNG_1x1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    expect(firstPage, 'first page exists').toBeTruthy();

    const bg = firstPage.pageElements?.['s1-bg'];
    expect(bg, 'A4 — backdrop IMAGE element at s1-bg').toBeTruthy();
    expect(bg.zIndex, 'backdrop sits at z=0').toBe(0);
    expect(bg.width, 'backdrop width matches page size').toBe(960);
    expect(bg.height, 'backdrop height matches page size').toBe(720);
    expect(bg.left, 'backdrop left = 0').toBe(0);
    expect(bg.top, 'backdrop top = 0').toBe(0);
    const contentUrl: string = bg.image?.imageProperties?.contentUrl ?? '';
    expect(contentUrl.startsWith('data:image/png;base64,'), 'data URI populated').toBe(true);
  });

  test('pptx import wave 7f — strikethrough + baseline + linked images (B8 + B9 + E2)', async ({ page }) => {
    // One slide carries three wave-7f items in one shot:
    //  • B8 — text run 1 has <a:rPr strike="sngStrike"/> → ts.st truthy.
    //  • B9 — text run 2 has <a:rPr baseline="30000"/> → ts.va === SUPERSCRIPT (3).
    //  • E2 — <p:pic> with <a:blip r:link="rId2"/>; rels rId2 →
    //         "https://example.com/img.png" passes through to
    //         imageProperties.contentUrl directly (no fetch).
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
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="914400"/><a:ext cx="5000000" cy="1000000"/></a:xfrm>` +
        `<a:prstGeom prst="rect"/>` +
        `</p:spPr>` +
        `<p:txBody>` +
        `<a:bodyPr/>` +
        `<a:p>` +
        `<a:r><a:rPr lang="en-US" strike="sngStrike"/><a:t>struck</a:t></a:r>` +
        `<a:r><a:rPr lang="en-US" baseline="30000"/><a:t>super</a:t></a:r>` +
        `</a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        `<p:pic>` +
        `<p:nvPicPr><p:cNvPr id="3" name="linked"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
        `<p:blipFill>` +
        `<a:blip r:link="rId2"/>` +
        `<a:stretch><a:fillRect/></a:stretch>` +
        `</p:blipFill>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="2500000"/><a:ext cx="2000000" cy="1500000"/></a:xfrm>` +
        `<a:prstGeom prst="rect"/>` +
        `</p:spPr>` +
        `</p:pic>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.com/img.png" TargetMode="External"/>` +
        `</Relationships>`;

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
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave7f.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    const elements = Object.values(firstPage.pageElements ?? {});

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = elements.find((e: any) => e.richText?.rich) as any;
    expect(text, 'text frame extracted with rich IDocumentData').toBeTruthy();
    const runs = text.richText.rich.body.textRuns;
    expect(runs.length, 'two text runs').toBeGreaterThanOrEqual(2);

    expect(runs[0].ts?.st, '<a:rPr strike="sngStrike"> → ts.st truthy').toBeTruthy();
    expect(runs[0].ts?.va, 'no baseline on run 1').toBeFalsy();

    expect(runs[1].ts?.va, '<a:rPr baseline="30000"> → ts.va === SUPERSCRIPT (3)').toBe(3);
    expect(runs[1].ts?.st, 'no strikethrough on run 2').toBeFalsy();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const img = elements.find((e: any) => e.image) as any;
    expect(img, 'linked image extracted').toBeTruthy();
    expect(img.image?.imageProperties?.contentUrl, 'r:link → contentUrl passthrough').toBe('https://example.com/img.png');
  });

  test('pptx import wave 7g — hidden slide + text wrap (A6 + C14)', async ({ page }) => {
    // Two slides, two items:
    //  • A6 — slide 1 has <p:sld show="0"> → slideProperties.isSkipped true.
    //         Slide 2 omits @show → no slideProperties block.
    //  • C14 — slide 2's text frame has <a:bodyPr wrap="none"/> → renderConfig.wrapStrategy
    //          equals WrapStrategy.OVERFLOW (1).
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
        `<p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>` +
        `</p:presentation>`;
      const presRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>` +
        `</Relationships>`;
      const slide1 =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" show="0">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slide2 =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="914400"/><a:ext cx="3000000" cy="800000"/></a:xfrm>` +
        `<a:prstGeom prst="rect"/>` +
        `</p:spPr>` +
        `<p:txBody>` +
        `<a:bodyPr wrap="none"/>` +
        `<a:p><a:r><a:rPr lang="en-US"/><a:t>nowrap</a:t></a:r></a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const emptyRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide1);
      zip.file('ppt/slides/slide2.xml', slide2);
      zip.file('ppt/slides/_rels/slide1.xml.rels', emptyRels);
      zip.file('ppt/slides/_rels/slide2.xml.rels', emptyRels);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave7g.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const pageOrder = r?.body?.pageOrder ?? [];
    expect(pageOrder.length, 'two pages imported').toBe(2);
    const page1 = r.body.pages[pageOrder[0]];
    const page2 = r.body.pages[pageOrder[1]];

    // A6 — slide 1 hidden, slide 2 visible.
    expect(page1.slideProperties?.isSkipped, 'slide 1 marked hidden').toBe(true);
    expect(page2.slideProperties, 'slide 2 has no slideProperties block').toBeUndefined();

    // C14 — slide 2's text frame carries wrapStrategy = OVERFLOW (1).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textEl = Object.values(page2.pageElements ?? {}).find((e: any) => e.richText) as any;
    expect(textEl, 'text frame extracted').toBeTruthy();
    const wrap = textEl.richText.rich?.documentStyle?.renderConfig?.wrapStrategy;
    expect(wrap, 'wrap="none" → WrapStrategy.OVERFLOW').toBe(1);
  });

  test('pptx import wave 7h — prstClr + sysClr + alpha + RTL (B12 + E4 + C9)', async ({ page }) => {
    // One slide carries three wave-7h items:
    //  • B12 — shape with <a:solidFill><a:prstClr val="red"/></a:solidFill>
    //          fill resolves to #FF0000.
    //  • E4  — <p:pic> with <a:blip><a:alphaModFix amt="40000"/></a:blip>
    //          → imageProperties.transparency ≈ 0.6 (1 - 0.4).
    //  • C9  — text frame with <a:pPr rtl="1"> paragraph; first paragraph's
    //          paragraphStyle.direction === TextDirection.RIGHT_TO_LEFT (2).
    const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const reimported = await page.evaluate(async (png) => {
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
        // B12 — shape with prstClr red fill.
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="prst"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="914400"/><a:ext cx="2000000" cy="1000000"/></a:xfrm>` +
        `<a:prstGeom prst="ellipse"/>` +
        `<a:solidFill><a:prstClr val="red"/></a:solidFill>` +
        `</p:spPr>` +
        `</p:sp>` +
        // C9 — text frame with RTL paragraph.
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="3" name="rtl"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="2200000"/><a:ext cx="5000000" cy="800000"/></a:xfrm>` +
        `<a:prstGeom prst="rect"/>` +
        `</p:spPr>` +
        `<p:txBody>` +
        `<a:bodyPr/>` +
        `<a:p><a:pPr rtl="1"/><a:r><a:rPr lang="ar"/><a:t>مرحبا</a:t></a:r></a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        // E4 — picture with alphaModFix amt=40000 (60% transparent).
        `<p:pic>` +
        `<p:nvPicPr><p:cNvPr id="4" name="alpha"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
        `<p:blipFill>` +
        `<a:blip r:embed="rId1"><a:alphaModFix amt="40000"/></a:blip>` +
        `<a:stretch><a:fillRect/></a:stretch>` +
        `</p:blipFill>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="3500000"/><a:ext cx="2000000" cy="1500000"/></a:xfrm>` +
        `<a:prstGeom prst="rect"/>` +
        `</p:spPr>` +
        `</p:pic>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>` +
        `</Relationships>`;

      const binary = atob(png);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels);
      zip.file('ppt/media/image1.png', bytes);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave7h.pptx');
    }, PNG_1x1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    const elements = Object.values(firstPage.pageElements ?? {});

    // B12 — prstClr red shape's fill is #FF0000.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ellipse = elements.find((e: any) => e.shape?.shapeType === 'ellipse') as any;
    expect(ellipse, 'ellipse with prstClr fill extracted').toBeTruthy();
    const fillHex = (ellipse.shape?.shapeProperties?.shapeBackgroundFill?.rgb ?? '').toUpperCase().replace('#', '');
    expect(fillHex, 'prstClr val="red" → #FF0000').toBe('FF0000');

    // C9 — RTL paragraph direction.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rtlText = elements.find((e: any) => e.richText?.text?.includes('مرحبا')) as any;
    expect(rtlText, 'RTL text frame extracted').toBeTruthy();
    const paragraphs = rtlText.richText.rich?.body?.paragraphs ?? [];
    expect(paragraphs.length, 'at least one paragraph').toBeGreaterThan(0);
    // TextDirection.RIGHT_TO_LEFT = 2.
    expect(paragraphs[0].paragraphStyle?.direction, '<a:pPr rtl="1"> → direction = RIGHT_TO_LEFT (2)').toBe(2);

    // E4 — alphaModFix amt=40000 → transparency 0.6.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const img = elements.find((e: any) => e.image) as any;
    expect(img, 'image with alphaModFix extracted').toBeTruthy();
    expect(img.image?.imageProperties?.transparency, 'amt=40000 → transparency ≈ 0.6').toBeCloseTo(0.6, 3);
  });

  test('pptx import wave 7i — hyperlinks via customRanges (B17)', async ({ page }) => {
    // <a:rPr><a:hlinkClick r:id="rId5"/></a:rPr> → ICustomRange on the
    // text frame's IDocumentBody.customRanges with rangeType=HYPERLINK (0)
    // and properties.url set to the rels Target.
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
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="914400"/><a:ext cx="5000000" cy="1000000"/></a:xfrm>` +
        `<a:prstGeom prst="rect"/>` +
        `</p:spPr>` +
        `<p:txBody>` +
        `<a:bodyPr/>` +
        // Two runs: plain prefix + hyperlinked suffix.
        `<a:p>` +
        `<a:r><a:rPr lang="en-US"/><a:t>visit </a:t></a:r>` +
        `<a:r><a:rPr lang="en-US"><a:hlinkClick r:id="rId2"/></a:rPr><a:t>anthropic</a:t></a:r>` +
        `</a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://anthropic.com" TargetMode="External"/>` +
        `</Relationships>`;

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
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave7i.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    const elements = Object.values(firstPage.pageElements ?? {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = elements.find((e: any) => e.richText?.rich) as any;
    expect(text, 'text frame extracted with rich IDocumentData').toBeTruthy();

    const customRanges = text.richText.rich?.body?.customRanges ?? [];
    expect(customRanges.length, 'one hyperlink range emitted').toBe(1);
    const hl = customRanges[0];
    // CustomRangeType.HYPERLINK = 0.
    expect(hl.rangeType, 'rangeType = HYPERLINK (0)').toBe(0);
    expect(hl.properties?.url, 'url passes through from rels Target').toBe('https://anthropic.com');
    // The hyperlink covers the second run ("anthropic", 9 chars) after
    // the plain prefix ("visit ", 6 chars).
    expect(hl.startIndex, 'range starts after prefix').toBe(6);
    expect(hl.endIndex, 'range ends after hyperlinked run').toBe(15);
  });

  test('pptx import wave 7j — autofit + body rotation (C12 + C13)', async ({ page }) => {
    // <a:bodyPr rot="5400000"> (90°) → documentStyle.renderConfig.centerAngle = 90.
    // <a:bodyPr><a:normAutofit fontScale="80000"/></a:bodyPr> shrinks the
    // run's fs by 0.8 at import: <a:rPr sz="2400"/> (24 pt) → 19.2 pt.
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
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="914400"/><a:ext cx="5000000" cy="1000000"/></a:xfrm>` +
        `<a:prstGeom prst="rect"/>` +
        `</p:spPr>` +
        `<p:txBody>` +
        // C12 + C13 stack on the same bodyPr.
        `<a:bodyPr rot="5400000"><a:normAutofit fontScale="80000"/></a:bodyPr>` +
        `<a:p>` +
        `<a:r><a:rPr lang="en-US" sz="2400"/><a:t>size 24</a:t></a:r>` +
        `</a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave7j.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    const elements = Object.values(firstPage.pageElements ?? {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = elements.find((e: any) => e.richText?.rich) as any;
    expect(text, 'text frame extracted with rich IDocumentData').toBeTruthy();

    // C12 — 5400000 / 60000 = 90°.
    const centerAngle = text.richText.rich?.documentStyle?.renderConfig?.centerAngle;
    expect(centerAngle, 'centerAngle reads rot in degrees').toBe(90);

    // C13 — 24 pt * (80000 / 100000) = 19.2 pt.
    const firstRun = text.richText.rich?.body?.textRuns?.[0];
    expect(firstRun, 'first ITextRun exists').toBeTruthy();
    expect(firstRun.ts?.fs, 'fs scaled by fontScale').toBe(19.2);
  });

  test('pptx import wave 7k — fork-patch enablement (B14 + D16 + I1 + I2 + J1)', async ({ page }) => {
    // Three model widenings landed via patches/@univerjs__core@0.24.0.patch
    // and the extended patches/@univerjs__slides@0.24.0.patch unlock five
    // fidelity items in one shot:
    //  • B14 — <a:rPr spc="200"> (200 hundredths of pt = 2.0 pt) → ts.spc = 2.
    //  • D16 — <a:ln cap="rnd"> → outline.cap = 'rnd'.
    //  • I1/I2/J1 — every layout/master/theme part is harvested from the
    //    zip into ISlideData.resources[].data under name CASUAL_SLIDES_PPTX_RAW.
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
        // B14 — text run with letter spacing.
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="spc"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="914400"/><a:ext cx="3000000" cy="800000"/></a:xfrm>` +
        `<a:prstGeom prst="rect"/>` +
        `</p:spPr>` +
        `<p:txBody>` +
        `<a:bodyPr/>` +
        `<a:p><a:r><a:rPr lang="en-US" spc="200"/><a:t>spaced</a:t></a:r></a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        // D16 — shape with outline cap="rnd".
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="3" name="cap"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="2000000"/><a:ext cx="3000000" cy="0"/></a:xfrm>` +
        `<a:prstGeom prst="line"/>` +
        `<a:ln w="25400" cap="rnd"><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></a:ln>` +
        `</p:spPr>` +
        `</p:sp>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
      const layout =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld name="dummy"><p:spTree/></p:cSld>` +
        `</p:sldLayout>`;
      const master =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree/></p:cSld>` +
        `</p:sldMaster>`;
      const theme =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Dummy"/>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels);
      zip.file('ppt/slideLayouts/slideLayout1.xml', layout);
      zip.file('ppt/slideMasters/slideMaster1.xml', master);
      zip.file('ppt/theme/theme1.xml', theme);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave7k.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    const elements = Object.values(firstPage.pageElements ?? {});

    // B14 — text run carries ts.spc = 2.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = elements.find((e: any) => e.richText?.text === 'spaced') as any;
    expect(text, 'spc text frame extracted').toBeTruthy();
    const runs = text.richText.rich?.body?.textRuns ?? [];
    expect(runs[0]?.ts?.spc, 'spc="200" → ts.spc = 2 pt').toBe(2);

    // D16 — line shape's outline carries cap='rnd'.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const line = elements.find((e: any) => e.shape?.shapeType === 'line') as any;
    expect(line, 'line shape extracted').toBeTruthy();
    expect(line.shape?.shapeProperties?.outline?.cap, 'outline.cap = "rnd"').toBe('rnd');

    // I1 + I2 + J1 — resources slot carries the raw XML payload.
    expect(Array.isArray(r.resources), 'resources slot populated').toBe(true);
    const passthrough = r.resources?.find((e: { name: string }) => e.name === 'CASUAL_SLIDES_PPTX_RAW');
    expect(passthrough, 'CASUAL_SLIDES_PPTX_RAW resource exists').toBeTruthy();
    const raw = JSON.parse(passthrough!.data);
    expect(raw.layouts['ppt/slideLayouts/slideLayout1.xml'], 'layout XML captured').toContain('p:sldLayout');
    expect(raw.masters['ppt/slideMasters/slideMaster1.xml'], 'master XML captured').toContain('p:sldMaster');
    expect(raw.themes['ppt/theme/theme1.xml'], 'theme XML captured').toContain('a:theme');
  });

  test('pptx import wave 7l — text highlight (B13)', async ({ page }) => {
    // `<a:rPr><a:highlight><a:srgbClr val="FFFF00"/></a:highlight></a:rPr>`
    // → `IStyleBase.bg = { rgb: '#FFFF00' }` on the first text run. The
    // existing `readColor` helper handles every colour-choice child
    // (srgbClr / schemeClr / prstClr / sysClr) uniformly, so no per-
    // variant test is needed here.
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
        `<p:nvSpPr><p:cNvPr id="2" name="hl"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="914400"/><a:ext cx="3000000" cy="800000"/></a:xfrm>` +
        `<a:prstGeom prst="rect"/>` +
        `</p:spPr>` +
        `<p:txBody>` +
        `<a:bodyPr/>` +
        `<a:p><a:r><a:rPr lang="en-US"><a:highlight><a:srgbClr val="FFFF00"/></a:highlight></a:rPr><a:t>important</a:t></a:r></a:p>` +
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
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave7l.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    const elements = Object.values(firstPage.pageElements ?? {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = elements.find((e: any) => e.richText?.text === 'important') as any;
    expect(text, 'highlight text frame extracted').toBeTruthy();
    const runs = text.richText.rich?.body?.textRuns ?? [];
    expect(runs[0]?.ts?.bg?.rgb, '<a:highlight><a:srgbClr val="FFFF00"/> → ts.bg.rgb = #FFFF00').toBe('#FFFF00');
  });

  test('pptx import wave 7m — text outline + arrowheads + effects (B15 + D17 + D18 + D19)', async ({ page }) => {
    // Four model widenings landed via patches/@univerjs__core@0.24.0.patch
    // unlock four fidelity items together:
    //  • B15 — text run with <a:rPr><a:ln w="12700"><a:solidFill><a:srgbClr val="333333"/></a:solidFill></a:ln> → ts.tol.
    //  • D17 — line shape with <a:ln><a:headEnd type="triangle"/><a:tailEnd type="arrow"/></a:ln> → outline.headEnd/tailEnd.
    //  • D18 — shape with <a:effectLst><a:outerShdw blurRad="50800" dist="38100" dir="2700000"><a:srgbClr val="000000"/></a:outerShdw> → effectLst.outerShdw.
    //  • D19 — same shape adds <a:glow rad="63500"><a:srgbClr val="FF0000"/></a:glow> → effectLst.glow.
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
        // B15 — text run with glyph outline.
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="outlined"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="914400"/><a:ext cx="3000000" cy="800000"/></a:xfrm>` +
        `<a:prstGeom prst="rect"/>` +
        `</p:spPr>` +
        `<p:txBody>` +
        `<a:bodyPr/>` +
        `<a:p><a:r>` +
        `<a:rPr lang="en-US"><a:ln w="12700"><a:solidFill><a:srgbClr val="333333"/></a:solidFill></a:ln></a:rPr>` +
        `<a:t>outlined</a:t>` +
        `</a:r></a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        // D17 — line shape with both arrowheads.
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="3" name="arrow"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="2000000"/><a:ext cx="3000000" cy="0"/></a:xfrm>` +
        `<a:prstGeom prst="line"/>` +
        `<a:ln w="19050">` +
        `<a:solidFill><a:srgbClr val="000000"/></a:solidFill>` +
        `<a:headEnd type="triangle" w="med" len="med"/>` +
        `<a:tailEnd type="arrow" w="lg" len="lg"/>` +
        `</a:ln>` +
        `</p:spPr>` +
        `</p:sp>` +
        // D18 + D19 — shape with shadow and glow effects.
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="4" name="effects"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="3000000"/><a:ext cx="2000000" cy="1000000"/></a:xfrm>` +
        `<a:prstGeom prst="rect"/>` +
        `<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>` +
        `<a:effectLst>` +
        `<a:outerShdw blurRad="50800" dist="38100" dir="2700000">` +
        `<a:srgbClr val="000000"/>` +
        `</a:outerShdw>` +
        `<a:glow rad="63500">` +
        `<a:srgbClr val="FF0000"/>` +
        `</a:glow>` +
        `</a:effectLst>` +
        `</p:spPr>` +
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
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave7m.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    const elements = Object.values(firstPage.pageElements ?? {});

    // B15 — text-glyph outline.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outlinedText = elements.find((e: any) => e.richText?.text === 'outlined') as any;
    expect(outlinedText, 'text frame with glyph outline extracted').toBeTruthy();
    const run = outlinedText.richText.rich?.body?.textRuns?.[0];
    expect(run?.ts?.tol?.color?.rgb, 'tol.color from <a:rPr><a:ln><a:solidFill><a:srgbClr>').toBe('#333333');
    // weight: 12700 EMU = 1 pt
    expect(run?.ts?.tol?.weight, 'tol.weight from <a:rPr><a:ln @w> (EMU → pt)').toBeCloseTo(1, 3);

    // D17 — line shape's arrowheads.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const arrow = elements.find((e: any) => e.shape?.shapeType === 'line') as any;
    expect(arrow, 'line shape extracted').toBeTruthy();
    expect(arrow.shape?.shapeProperties?.outline?.headEnd?.type, 'headEnd type').toBe('triangle');
    expect(arrow.shape?.shapeProperties?.outline?.headEnd?.w, 'headEnd w').toBe('med');
    expect(arrow.shape?.shapeProperties?.outline?.tailEnd?.type, 'tailEnd type').toBe('arrow');
    expect(arrow.shape?.shapeProperties?.outline?.tailEnd?.len, 'tailEnd len').toBe('lg');

    // D18 + D19 — effectLst.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const effShape = elements.find((e: any) => e.shape?.shapeType === 'rect' && e.shape?.shapeProperties?.effectLst) as any;
    expect(effShape, 'shape with effectLst extracted').toBeTruthy();
    const fx = effShape.shape.shapeProperties.effectLst;
    expect(fx?.outerShdw?.color?.rgb, 'outerShdw color').toBe('#000000');
    expect(fx?.outerShdw?.blurRad, 'outerShdw blurRad EMU').toBe(50800);
    expect(fx?.outerShdw?.dist, 'outerShdw dist EMU').toBe(38100);
    expect(fx?.outerShdw?.dir, 'outerShdw dir (60000ths-deg)').toBe(2700000);
    expect(fx?.glow?.color?.rgb, 'glow color').toBe('#FF0000');
    expect(fx?.glow?.rad, 'glow rad EMU').toBe(63500);
  });

  test('pptx import + export wave 7n — passthrough round-trip (A9 + K5 + K7 + K8)', async ({ page }) => {
    // Build a synthetic deck carrying notesSlides + comments + diagrams +
    // ink parts. After import, the resources slot should hold all four
    // categories. After re-exporting, the produced zip should contain
    // them at their original paths (since PptxGenJS doesn't generate
    // these categories, restorePassthrough can safely inject them back).
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const result = await page.evaluate(async () => {
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
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const emptyRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
      const notesSlide = `<?xml version="1.0"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><speaker>presenter notes</speaker></p:notes>`;
      const comment = `<?xml version="1.0"?><p:cmLst xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cm authorId="0"><p:text>Looks good</p:text></p:cm></p:cmLst>`;
      const diagram = `<?xml version="1.0"?><dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:ptLst/></dgm:dataModel>`;
      const ink = `<?xml version="1.0"?><inkml:ink xmlns:inkml="http://www.w3.org/2003/InkML"><inkml:trace>0 0, 1 1, 2 2</inkml:trace></inkml:ink>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', emptyRels);
      zip.file('ppt/notesSlides/notesSlide1.xml', notesSlide);
      zip.file('ppt/notesSlides/_rels/notesSlide1.xml.rels', emptyRels);
      zip.file('ppt/comments/comment1.xml', comment);
      zip.file('ppt/diagrams/data1.xml', diagram);
      zip.file('ppt/ink/ink1.xml', ink);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
          export(snapshot: unknown): Promise<{ blob: Blob; fileName: string }>;
        };
      };
      const client = (window as unknown as W).__casualSlides_getPptxClient();
      const snapshot = await client.import(buf, 'wave7n.pptx');

      // Re-export and re-open the produced blob to verify the parts
      // survive the round-trip.
      const { blob } = await client.export(snapshot);
      const reZip = await JSZip.loadAsync(await blob.arrayBuffer());
      const notesPath = 'ppt/notesSlides/notesSlide1.xml';
      const commentPath = 'ppt/comments/comment1.xml';
      const diagramPath = 'ppt/diagrams/data1.xml';
      const inkPath = 'ppt/ink/ink1.xml';
      return {
        snapshot,
        exportedNotes: (await reZip.file(notesPath)?.async('string')) ?? null,
        exportedComment: (await reZip.file(commentPath)?.async('string')) ?? null,
        exportedDiagram: (await reZip.file(diagramPath)?.async('string')) ?? null,
        exportedInk: (await reZip.file(inkPath)?.async('string')) ?? null,
      };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = result.snapshot;
    const resources: Array<{ name: string; data: string }> | undefined = r.resources;
    expect(resources, 'resources slot populated').toBeTruthy();
    const passthrough = resources!.find((e) => e.name === 'CASUAL_SLIDES_PPTX_RAW');
    expect(passthrough, 'CASUAL_SLIDES_PPTX_RAW resource exists').toBeTruthy();
    const raw = JSON.parse(passthrough!.data);
    expect(Object.keys(raw.notesSlides ?? {}), 'notesSlides captured').toContain('ppt/notesSlides/notesSlide1.xml');
    expect(Object.keys(raw.comments ?? {}), 'comments captured').toContain('ppt/comments/comment1.xml');
    expect(Object.keys(raw.diagrams ?? {}), 'diagrams captured').toContain('ppt/diagrams/data1.xml');
    expect(Object.keys(raw.ink ?? {}), 'ink captured').toContain('ppt/ink/ink1.xml');

    // Export-side restoration.
    expect(result.exportedNotes, 'notesSlide present in exported zip').toContain('presenter notes');
    expect(result.exportedComment, 'comment present in exported zip').toContain('Looks good');
    expect(result.exportedDiagram, 'diagram present in exported zip').toContain('dgm:dataModel');
    expect(result.exportedInk, 'ink present in exported zip').toContain('inkml:ink');
  });

  test('pptx import wave 7o — table + chart Gap 3 (G1-G4 + H1)', async ({ page }) => {
    // Slide carries a 2x2 table with one merged cell and a chart
    // graphicFrame referencing ppt/charts/chart1.xml. After import:
    //  • Table element (type 6 = PageElementType.TABLE) holds the
    //    full row × cell structure including the colSpan.
    //  • Chart element (type 7 = PageElementType.CHART) holds the rId
    //    reference, and the chart XML is captured in CASUAL_SLIDES_PPTX_RAW.charts.
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
        // G1-G4 — 2x2 table with first cell of row 1 spanning two columns.
        `<p:graphicFrame>` +
        `<p:nvGraphicFramePr><p:cNvPr id="2" name="tbl"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
        `<p:xfrm><a:off x="914400" y="914400"/><a:ext cx="4000000" cy="1500000"/></p:xfrm>` +
        `<a:graphic>` +
        `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">` +
        `<a:tbl>` +
        `<a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid>` +
        // Row 1 — first cell spans 2 columns.
        `<a:tr h="750000">` +
        `<a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:rPr/><a:t>Header</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="DDDDDD"/></a:solidFill></a:tcPr></a:tc>` +
        // Merge-target cell at row 1, column 2.
        `<a:tc hMerge="1"><a:txBody><a:bodyPr/><a:p/></a:txBody><a:tcPr/></a:tc>` +
        `</a:tr>` +
        // Row 2.
        `<a:tr h="750000">` +
        `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr/><a:t>A</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>` +
        `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr/><a:t>B</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>` +
        `</a:tr>` +
        `</a:tbl>` +
        `</a:graphicData>` +
        `</a:graphic>` +
        `</p:graphicFrame>` +
        // H1 — chart graphicFrame.
        `<p:graphicFrame>` +
        `<p:nvGraphicFramePr><p:cNvPr id="3" name="chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
        `<p:xfrm><a:off x="914400" y="3000000"/><a:ext cx="3000000" cy="2000000"/></p:xfrm>` +
        `<a:graphic>` +
        `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
        `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId2"/>` +
        `</a:graphicData>` +
        `</a:graphic>` +
        `</p:graphicFrame>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>` +
        `</Relationships>`;
      const chart =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
        `<c:chart><c:plotArea><c:layout/><c:barChart/></c:plotArea></c:chart>` +
        `</c:chartSpace>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels);
      zip.file('ppt/charts/chart1.xml', chart);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
          export(snapshot: unknown): Promise<{ blob: Blob; fileName: string }>;
        };
      };
      const client = (window as unknown as W).__casualSlides_getPptxClient();
      const snapshot = await client.import(buf, 'wave7o.pptx');

      const { blob } = await client.export(snapshot);
      const reZip = await JSZip.loadAsync(await blob.arrayBuffer());
      return {
        snapshot,
        chartXml: (await reZip.file('ppt/charts/chart1.xml')?.async('string')) ?? null,
      };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported.snapshot;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    const elements = Object.values(firstPage.pageElements ?? {});

    // G1-G4 — table element.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tableEl = elements.find((e: any) => e.type === 6) as any;
    expect(tableEl, 'TABLE element emitted').toBeTruthy();
    expect(tableEl.table?.rows?.length, '2 rows').toBe(2);
    expect(tableEl.table?.columnWidths?.length, '2 columns in tblGrid').toBe(2);
    expect(tableEl.table?.rows?.[0]?.cells?.[0]?.colSpan, 'first cell gridSpan=2').toBe(2);
    expect(tableEl.table?.rows?.[0]?.cells?.[0]?.fillRgb, 'header cell fill').toBeTruthy();
    expect(tableEl.table?.rows?.[0]?.cells?.[1]?.hMerge, 'second cell of row 1 is merge target').toBe(true);
    expect(tableEl.table?.rows?.[1]?.cells?.[0]?.text, 'data cell A text').toBe('A');
    expect(tableEl.table?.rows?.[1]?.cells?.[1]?.text, 'data cell B text').toBe('B');

    // H1 — chart element + passthrough.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chartEl = elements.find((e: any) => e.type === 7) as any;
    expect(chartEl, 'CHART element emitted').toBeTruthy();
    expect(chartEl.chart?.chartId, 'chart rId captured').toBe('rId2');
    const resources: Array<{ name: string; data: string }> | undefined = r.resources;
    const passthrough = resources?.find((e) => e.name === 'CASUAL_SLIDES_PPTX_RAW');
    expect(passthrough, 'passthrough resource exists').toBeTruthy();
    const raw = JSON.parse(passthrough!.data);
    expect(Object.keys(raw.charts ?? {}), 'chart XML captured').toContain('ppt/charts/chart1.xml');

    // Export restoration — chart XML survives.
    expect(reimported.chartXml, 'chart XML restored on export').toContain('c:barChart');
  });

  test('pptx import wave 8b — theme font scheme fallback (J3)', async ({ page }) => {
    // Hand-roll a deck where:
    //   • theme defines majorFont latin="Heading Sans" and minorFont latin="Body Serif"
    //   • slide carries TWO placeholders, neither with an explicit
    //     `<a:latin typeface=…>` in the run rPr:
    //       1. type="title" — should pick up the major font
    //       2. type="body" idx="1" — should pick up the minor font
    // After J3, parseRunProps falls back to the theme's font scheme; before,
    // both runs landed with no ff and rendered in the default browser font.
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
      // Two placeholders: title + body. Neither run carries <a:latin>.
      const slide =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        // Title placeholder
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="7315200" cy="1371600"/></a:xfrm></p:spPr>` +
        `<p:txBody><a:bodyPr/><a:lstStyle/>` +
        `<a:p><a:r><a:rPr lang="en-US"/><a:t>Heading text</a:t></a:r></a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        // Body placeholder
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="914400" y="2057400"/><a:ext cx="7315200" cy="3429000"/></a:xfrm></p:spPr>` +
        `<p:txBody><a:bodyPr/><a:lstStyle/>` +
        `<a:p><a:r><a:rPr lang="en-US"/><a:t>Body content</a:t></a:r></a:p>` +
        `</p:txBody>` +
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
        `</p:spTree></p:cSld>` +
        `</p:sldLayout>`;
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
        `</p:spTree></p:cSld>` +
        `</p:sldMaster>`;
      const masterRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>` +
        `</Relationships>`;
      // Theme — fontScheme carries majorFont=Heading Sans, minorFont=Body Serif.
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
        `<a:fontScheme name="TestFonts">` +
        `<a:majorFont><a:latin typeface="Heading Sans"/></a:majorFont>` +
        `<a:minorFont><a:latin typeface="Body Serif"/></a:minorFont>` +
        `</a:fontScheme>` +
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
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave8b-font-scheme.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = reimported;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    expect(firstPage, 'first page extracted').toBeTruthy();
    const elements = Object.values(firstPage.pageElements ?? {});
    expect(elements.length, 'two placeholders captured').toBe(2);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const titleEl = elements.find((e: any) => e.richText?.text?.includes('Heading')) as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bodyEl = elements.find((e: any) => e.richText?.text?.includes('Body')) as any;
    expect(titleEl, 'title element extracted').toBeTruthy();
    expect(bodyEl, 'body element extracted').toBeTruthy();

    // The run-level ff falls back to the theme's major / minor Latin
    // typeface. Both flat (legacy) and rich (per-run) paths reflect it —
    // we assert via the flat field since that's what the renderer
    // fallback consults.
    expect(titleEl.richText?.ff, 'title falls back to major font').toBe('Heading Sans');
    expect(bodyEl.richText?.ff, 'body falls back to minor font').toBe('Body Serif');
    // And the rich path's first textRun carries the same ts.ff so the
    // multi-run renderer also resolves correctly.
    const titleRun = titleEl.richText?.rich?.body?.textRuns?.[0];
    const bodyRun = bodyEl.richText?.rich?.body?.textRuns?.[0];
    expect(titleRun?.ts?.ff, 'rich title run carries major font').toBe('Heading Sans');
    expect(bodyRun?.ts?.ff, 'rich body run carries minor font').toBe('Body Serif');
  });

  test('pptx import wave 8c — deck metadata from docProps/core.xml (K1)', async ({ page }) => {
    // Hand-roll a deck with docProps/core.xml carrying dc:title. After
    // import, snapshot.title comes from the XML, not from the filename.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const snapshot = await page.evaluate(async () => {
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
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const emptyRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
      // K1 — docProps/core.xml. The canonical OOXML namespaces are
      // cp / dc / dcterms / dcmitype / xsi.
      const core =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
        `<dc:title>Q3 Roadmap Review</dc:title>` +
        `<dc:creator>Pat Author</dc:creator>` +
        `<dc:description>Internal-only briefing deck.</dc:description>` +
        `<dc:subject>Roadmap</dc:subject>` +
        `</cp:coreProperties>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', emptyRels);
      zip.file('docProps/core.xml', core);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      const client = (window as unknown as W).__casualSlides_getPptxClient();
      return await client.import(buf, 'fallback-filename.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = snapshot;
    // K1 — title from <dc:title>, not from the filename.
    expect(r.title, 'snapshot.title from dc:title').toBe('Q3 Roadmap Review');
  });

  test('pptx import wave 8d — custom props passthrough (K2)', async ({ page }) => {
    // Hand-roll a deck with docProps/custom.xml. After import, the
    // resources passthrough carries the bytes; after re-export, the
    // produced zip still contains the original docProps/custom.xml.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const result = await page.evaluate(async () => {
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
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const emptyRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
      // K2 — author-defined custom properties.
      const custom =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
        `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ReviewedBy"><vt:lpwstr>Alex Reviewer</vt:lpwstr></property>` +
        `</Properties>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', emptyRels);
      zip.file('docProps/custom.xml', custom);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
          export(snapshot: unknown): Promise<{ blob: Blob; fileName: string }>;
        };
      };
      const client = (window as unknown as W).__casualSlides_getPptxClient();
      const snapshot = await client.import(buf, 'wave8d-custom.pptx');

      // Round-trip — restorePassthrough re-injects the bytes.
      const { blob } = await client.export(snapshot);
      const reZip = await JSZip.loadAsync(await blob.arrayBuffer());
      return {
        snapshot,
        exportedCustom: (await reZip.file('docProps/custom.xml')?.async('string')) ?? null,
      };
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = result.snapshot;
    const resources: Array<{ name: string; data: string }> | undefined = r.resources;
    expect(resources, 'resources slot populated').toBeTruthy();
    const passthrough = resources!.find((e) => e.name === 'CASUAL_SLIDES_PPTX_RAW');
    expect(passthrough, 'CASUAL_SLIDES_PPTX_RAW resource exists').toBeTruthy();
    const raw = JSON.parse(passthrough!.data);
    expect(raw.customProps, 'customProps bucket populated').toBeTruthy();
    expect(raw.customProps['docProps/custom.xml'], 'docProps/custom.xml bytes captured').toContain('ReviewedBy');

    // Export — bytes survive into the produced zip.
    expect(result.exportedCustom, 'docProps/custom.xml restored on export').toContain('ReviewedBy');
    expect(result.exportedCustom, 'value survives').toContain('Alex Reviewer');
  });

  test('pptx import wave 8e — deck-level default text style (K3)', async ({ page }) => {
    // Hand-roll a deck where the only text frame is a non-placeholder
    // shape with a bare `<a:r>` (no rPr, no layout / master inheritance).
    // Before K3, runs landed without any style. With K3, the deck-level
    // `<p:defaultTextStyle><p:lvl1pPr><a:defRPr sz="2200" b="1">...`
    // supplies the lowest-priority defaults.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const snapshot = await page.evaluate(async () => {
      const presentation =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:sldSz cx="9144000" cy="6858000"/>` +
        `<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>` +
        // K3 — deck-level default text style: 22 pt bold, Verdana, red.
        `<p:defaultTextStyle>` +
        `<a:lvl1pPr>` +
        `<a:defRPr sz="2200" b="1">` +
        `<a:solidFill><a:srgbClr val="CC0033"/></a:solidFill>` +
        `<a:latin typeface="Verdana"/>` +
        `</a:defRPr>` +
        `</a:lvl1pPr>` +
        `</p:defaultTextStyle>` +
        `</p:presentation>`;
      const presRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>` +
        `</Relationships>`;
      // Slide: one shape with a text frame, run has NO rPr — so the only
      // chance for style is the deck-default.
      const slide =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="3000000" cy="800000"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr>` +
        `<p:txBody><a:bodyPr/><a:lstStyle/>` +
        // Bare run — no rPr at all. Only the deck-default can supply style.
        `<a:p><a:r><a:t>deck default</a:t></a:r></a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const emptyRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', emptyRels);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave8e.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = snapshot;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    expect(firstPage, 'first page extracted').toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textEl = Object.values(firstPage.pageElements ?? {}).find((e: any) => e.richText?.text === 'deck default') as any;
    expect(textEl, 'text element extracted').toBeTruthy();
    // K3 — fs/bl/ff/cl all come from the deck-level defRPr.
    expect(textEl.richText?.fs, 'deck default fs').toBe(22);
    expect(textEl.richText?.bl, 'deck default bold').toBe(1);
    expect(textEl.richText?.ff, 'deck default ff').toBe('Verdana');
    const colorHex = (textEl.richText?.cl?.rgb ?? '').toUpperCase().replace('#', '');
    expect(colorHex, 'deck default color').toBe('CC0033');
  });

  test('pptx import wave 8f — footer / date / sldNum from master (I5)', async ({ page }) => {
    // Hand-roll a deck where the slide has no service placeholders, but
    // the master defines `<p:ph type="ftr">` (with text "Confidential")
    // and `<p:ph type="sldNum">` (with text "‹#›"). After import, both
    // should land as TEXT elements with the layout/master-supplied
    // geometry, so the renderer doesn't drop the footer / slide number.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const snapshot = await page.evaluate(async () => {
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
      // Slide has NO placeholders — just an empty spTree.
      const slide =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
        `</Relationships>`;
      // Layout — empty, just points at the master.
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
      // Master carries two service placeholders with text + geometry.
      const master =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        // ftr — at (0.5 in, 6.5 in) sized (3 in × 0.3 in). Text: "Confidential".
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="ftr"/><p:cNvSpPr/><p:nvPr><p:ph type="ftr" sz="quarter" idx="11"/></p:nvPr></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="457200" y="5943600"/><a:ext cx="2743200" cy="274320"/></a:xfrm></p:spPr>` +
        `<p:txBody><a:bodyPr/><a:lstStyle/>` +
        `<a:p><a:r><a:rPr lang="en-US"/><a:t>Confidential</a:t></a:r></a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        // sldNum — at (8 in, 6.5 in) sized (1 in × 0.3 in). Text: a slide-number sentinel.
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="3" name="sldNum"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" sz="quarter" idx="12"/></p:nvPr></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="7315200" y="5943600"/><a:ext cx="914400" cy="274320"/></a:xfrm></p:spPr>` +
        `<p:txBody><a:bodyPr/><a:lstStyle/>` +
        `<a:p><a:fld id="{F1}" type="slidenum"><a:t>#</a:t></a:fld></a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        `</p:spTree></p:cSld>` +
        `</p:sldMaster>`;
      const masterRels =
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
      zip.file('ppt/slideMasters/slideMaster1.xml', master);
      zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', masterRels);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave8f-service-ph.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = snapshot;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    expect(firstPage, 'first page extracted').toBeTruthy();
    const elements = Object.values(firstPage.pageElements ?? {});
    // Slide had nothing; only the synthesised service placeholders survive.
    expect(elements.length, 'service placeholders emitted').toBe(2);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const footer = elements.find((e: any) => e.richText?.text?.includes('Confidential')) as any;
    expect(footer, 'footer emitted').toBeTruthy();
    expect(footer.type, 'footer is a TEXT element').toBe(2); // PageElementType.TEXT = 2
    // Geometry from master: (0.5 in, 6.5 in) = (48 px, 624 px) — 9525 EMU/px.
    expect(footer.left, 'footer left inherited from master').toBeCloseTo(48, 0);
    expect(footer.top, 'footer top inherited from master').toBeCloseTo(624, 0);
    expect(footer.width, 'footer width inherited').toBeCloseTo(288, 0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sldNum = elements.find((e: any) => e.id?.includes('svc-sldNum')) as any;
    expect(sldNum, 'sldNum emitted').toBeTruthy();
    expect(sldNum.type, 'sldNum is a TEXT element').toBe(2);
    expect(sldNum.left, 'sldNum left inherited from master').toBeCloseTo(768, 0);
  });

  test('pptx import wave 9a — slide <p:hf> opts out service placeholders (K4)', async ({ page }) => {
    // Master declares both ftr and sldNum service placeholders. Slide
    // sets `<p:hf sldNum="0"/>`, opting out of the page number. After
    // import, the footer survives but the slide-number is skipped.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const snapshot = await page.evaluate(async () => {
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
      // Slide opts out of slide-number via <p:hf sldNum="0"/>; ftr stays
      // implicit (default = visible).
      const slide =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `</p:spTree></p:cSld>` +
        `<p:hf sldNum="0"/>` +
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
        `</p:spTree></p:cSld>` +
        `</p:sldLayout>`;
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
        // ftr
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="ftr"/><p:cNvSpPr/><p:nvPr><p:ph type="ftr" sz="quarter" idx="11"/></p:nvPr></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="457200" y="5943600"/><a:ext cx="2743200" cy="274320"/></a:xfrm></p:spPr>` +
        `<p:txBody><a:bodyPr/><a:lstStyle/>` +
        `<a:p><a:r><a:rPr lang="en-US"/><a:t>FooterText</a:t></a:r></a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        // sldNum — slide opts out, should NOT appear in the result.
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="3" name="sldNum"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" sz="quarter" idx="12"/></p:nvPr></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="7315200" y="5943600"/><a:ext cx="914400" cy="274320"/></a:xfrm></p:spPr>` +
        `<p:txBody><a:bodyPr/><a:lstStyle/>` +
        `<a:p><a:r><a:rPr lang="en-US"/><a:t>PageNum</a:t></a:r></a:p>` +
        `</p:txBody>` +
        `</p:sp>` +
        `</p:spTree></p:cSld>` +
        `</p:sldMaster>`;
      const masterRels =
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
      zip.file('ppt/slideMasters/slideMaster1.xml', master);
      zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', masterRels);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave9a-hf-optout.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = snapshot;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    expect(firstPage, 'first page extracted').toBeTruthy();
    const elements = Object.values(firstPage.pageElements ?? {});
    // Only the footer should have been synthesised (sldNum opted out).
    expect(elements.length, 'only footer synthesised (sldNum opted out)').toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ftr = elements.find((e: any) => e.richText?.text?.includes('FooterText')) as any;
    expect(ftr, 'footer survives <p:hf> default').toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sldNum = elements.find((e: any) => e.id?.includes('svc-sldNum'));
    expect(sldNum, 'sldNum suppressed by <p:hf sldNum="0">').toBeFalsy();
  });

  test('pptx import wave 9b — <p:bgRef idx> resolves bgFillStyleLst (A5-idx)', async ({ page }) => {
    // Master carries `<p:bg><p:bgRef idx="1002">` (2nd bgFillStyleLst
    // entry). Theme's bgFillStyleLst[1] is <a:solidFill><a:srgbClr
    // val="3366CC"/>. After import the slide's pageBackgroundFill
    // should be #3366CC.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const snapshot = await page.evaluate(async () => {
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
      // Slide carries no background of its own — falls through to master.
      const slide =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
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
        `</p:spTree></p:cSld>` +
        `</p:sldLayout>`;
      const layoutRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
        `</Relationships>`;
      // Master carries the bgRef. idx="1002" → 2nd bgFillStyleLst entry.
      const master =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld>` +
        `<p:bg><p:bgRef idx="1002"><a:schemeClr val="bg1"/></p:bgRef></p:bg>` +
        `<p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `</p:spTree></p:cSld>` +
        `</p:sldMaster>`;
      const masterRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>` +
        `</Relationships>`;
      // Theme — bgFillStyleLst with three entries; the 2nd is solidFill #3366CC.
      const theme =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="TestTheme">` +
        `<a:themeElements>` +
        `<a:clrScheme name="Test">` +
        `<a:dk1><a:srgbClr val="000000"/></a:dk1>` +
        `<a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>` +
        `<a:dk2><a:srgbClr val="333333"/></a:dk2>` +
        `<a:lt2><a:srgbClr val="EEEEEE"/></a:lt2>` +
        `<a:accent1><a:srgbClr val="FF0000"/></a:accent1>` +
        `<a:accent2><a:srgbClr val="00FF00"/></a:accent2>` +
        `<a:accent3><a:srgbClr val="0000FF"/></a:accent3>` +
        `<a:accent4><a:srgbClr val="FFFF00"/></a:accent4>` +
        `<a:accent5><a:srgbClr val="00FFFF"/></a:accent5>` +
        `<a:accent6><a:srgbClr val="FF00FF"/></a:accent6>` +
        `<a:hlink><a:srgbClr val="0000EE"/></a:hlink>` +
        `<a:folHlink><a:srgbClr val="551A8B"/></a:folHlink>` +
        `</a:clrScheme>` +
        `<a:fontScheme name="TestFonts">` +
        `<a:majorFont><a:latin typeface="Heading Sans"/></a:majorFont>` +
        `<a:minorFont><a:latin typeface="Body Serif"/></a:minorFont>` +
        `</a:fontScheme>` +
        `<a:fmtScheme name="TestFmt">` +
        `<a:fillStyleLst>` +
        `<a:solidFill><a:srgbClr val="111111"/></a:solidFill>` +
        `<a:solidFill><a:srgbClr val="222222"/></a:solidFill>` +
        `<a:solidFill><a:srgbClr val="333333"/></a:solidFill>` +
        `</a:fillStyleLst>` +
        `<a:lnStyleLst><a:ln/></a:lnStyleLst>` +
        `<a:effectStyleLst><a:effectStyle/></a:effectStyleLst>` +
        `<a:bgFillStyleLst>` +
        `<a:solidFill><a:srgbClr val="AABBCC"/></a:solidFill>` +
        `<a:solidFill><a:srgbClr val="3366CC"/></a:solidFill>` +
        `<a:solidFill><a:srgbClr val="DDEEFF"/></a:solidFill>` +
        `</a:bgFillStyleLst>` +
        `</a:fmtScheme>` +
        `</a:themeElements>` +
        `</a:theme>`;

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
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave9b-bgref-idx.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = snapshot;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    expect(firstPage, 'first page extracted').toBeTruthy();
    const bgHex = (firstPage?.pageBackgroundFill?.rgb ?? '').toUpperCase().replace('#', '');
    expect(bgHex, 'bgRef idx=1002 resolved to bgFillStyleLst[1]').toBe('3366CC');
  });

  test('pptx import wave 9c — gradient stops harvested (A3 + D9)', async ({ page }) => {
    // Shape carries <a:gradFill> with 3 stops + a 45° linear angle.
    // After import the shape's shapeProperties.shapeBackgroundFill
    // keeps the first-stop hex (existing degradation) AND a new
    // gradientFill payload carries kind + angle + stops.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const snapshot = await page.evaluate(async () => {
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
        `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree>` +
        `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/>` +
        `<p:sp>` +
        `<p:nvSpPr><p:cNvPr id="2" name="rect-grad"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="914400"/><a:ext cx="3657600" cy="2743200"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
        `<a:gradFill flip="none" rotWithShape="1">` +
        `<a:gsLst>` +
        `<a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs>` +
        `<a:gs pos="50000"><a:srgbClr val="00FF00"/></a:gs>` +
        `<a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs>` +
        `</a:gsLst>` +
        `<a:lin ang="2700000" scaled="1"/>` +
        `</a:gradFill>` +
        `</p:spPr>` +
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
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave9c-grad.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = snapshot;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shape = Object.values(firstPage.pageElements ?? {}).find((e: any) => e.shape?.shapeType === 'rect') as any;
    expect(shape, 'shape extracted').toBeTruthy();
    // Degraded flat colour preserved (first stop = red).
    const flat = (shape.shape?.shapeProperties?.shapeBackgroundFill?.rgb ?? '').toUpperCase().replace('#', '');
    expect(flat, 'first-stop fallback hex preserved').toBe('FF0000');
    // Full gradient payload.
    const grad = shape.shape?.shapeProperties?.gradientFill;
    expect(grad, 'gradient payload emitted').toBeTruthy();
    expect(grad.kind).toBe('linear');
    // 2700000 / 60000 = 45°.
    expect(grad.angle).toBeCloseTo(45, 0);
    expect(grad.stops.length).toBe(3);
    expect(grad.stops[0].pos).toBeCloseTo(0, 3);
    expect((grad.stops[0].color ?? '').toUpperCase().replace('#', '')).toBe('FF0000');
    expect(grad.stops[1].pos).toBeCloseTo(0.5, 3);
    expect((grad.stops[1].color ?? '').toUpperCase().replace('#', '')).toBe('00FF00');
    expect(grad.stops[2].pos).toBeCloseTo(1, 3);
    expect((grad.stops[2].color ?? '').toUpperCase().replace('#', '')).toBe('0000FF');
  });

  test('pptx import wave 9d — chart data + type parsed (H2 + H3)', async ({ page }) => {
    // Slide carries a graphicFrame referencing chart1.xml. The chart
    // is a <c:barChart> with categories [A, B, C] and series Sales
    // [10, 20, 30]. After import, the CHART element's `chart` payload
    // carries chartType='bar' + categories + series.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const snapshot = await page.evaluate(async () => {
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
        `<p:graphicFrame>` +
        `<p:nvGraphicFramePr><p:cNvPr id="2" name="chart-1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
        `<p:xfrm><a:off x="914400" y="914400"/><a:ext cx="3657600" cy="2743200"/></p:xfrm>` +
        `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
        `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId2"/>` +
        `</a:graphicData></a:graphic>` +
        `</p:graphicFrame>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>` +
        `</Relationships>`;
      const chartXml =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<c:chart>` +
        `<c:plotArea>` +
        `<c:layout/>` +
        `<c:barChart>` +
        `<c:barDir val="col"/>` +
        `<c:grouping val="clustered"/>` +
        `<c:ser>` +
        `<c:idx val="0"/><c:order val="0"/>` +
        `<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Sales</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
        `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$4</c:f><c:strCache><c:ptCount val="3"/>` +
        `<c:pt idx="0"><c:v>A</c:v></c:pt>` +
        `<c:pt idx="1"><c:v>B</c:v></c:pt>` +
        `<c:pt idx="2"><c:v>C</c:v></c:pt>` +
        `</c:strCache></c:strRef></c:cat>` +
        `<c:val><c:numRef><c:f>Sheet1!$B$2:$B$4</c:f><c:numCache><c:ptCount val="3"/>` +
        `<c:pt idx="0"><c:v>10</c:v></c:pt>` +
        `<c:pt idx="1"><c:v>20</c:v></c:pt>` +
        `<c:pt idx="2"><c:v>30</c:v></c:pt>` +
        `</c:numCache></c:numRef></c:val>` +
        `</c:ser>` +
        `</c:barChart>` +
        `</c:plotArea>` +
        `</c:chart>` +
        `</c:chartSpace>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels);
      zip.file('ppt/charts/chart1.xml', chartXml);
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave9d-chart.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = snapshot;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chartEl = Object.values(firstPage.pageElements ?? {}).find((e: any) => e.type === 7) as any;
    expect(chartEl, 'CHART element extracted').toBeTruthy();
    expect(chartEl.chart?.chartType, 'chartType stripped to "bar"').toBe('bar');
    expect(chartEl.chart?.categories, 'categories captured').toEqual(['A', 'B', 'C']);
    expect(chartEl.chart?.series, 'series captured').toBeTruthy();
    expect(chartEl.chart.series.length, 'one series').toBe(1);
    expect(chartEl.chart.series[0].name, 'series name').toBe('Sales');
    expect(chartEl.chart.series[0].values, 'series values').toEqual([10, 20, 30]);
  });

  test('pptx import wave 9e — image colour adjust + effects (E5 + E6)', async ({ page }) => {
    // Slide carries <p:pic> with <a:blip> containing:
    //   <a:lum bright="20000" contrast="-10000"/>  → +20 / -10 %
    //   <a:grayscl/>
    //   <a:duotone><a:srgbClr val="FF0000"/><a:srgbClr val="0000FF"/></a:duotone>
    //   <a:effectLst><a:outerShdw blurRad="50800" dist="38100"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst>
    // After import, imageProperties carries brightness, contrast,
    // grayscale, duotone, and effectLst.
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as { __casualSlides_getPptxClient?: unknown }).__casualSlides_getPptxClient === 'function',
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(600);

    const snapshot = await page.evaluate(async () => {
      // Minimal 1×1 PNG (red pixel) base64 → bytes for the image part.
      const png1x1Red = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9Q DwADhgGAWjR9awAAAABJRU5ErkJggg=='.replace(/\s+/g, '');
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
        `<p:pic>` +
        `<p:nvPicPr><p:cNvPr id="2" name="pic1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>` +
        `<p:blipFill>` +
        `<a:blip r:embed="rId2">` +
        `<a:lum bright="20000" contrast="-10000"/>` +
        `<a:grayscl/>` +
        `<a:duotone>` +
        `<a:srgbClr val="FF0000"/>` +
        `<a:srgbClr val="0000FF"/>` +
        `</a:duotone>` +
        `</a:blip>` +
        `<a:stretch><a:fillRect/></a:stretch>` +
        `</p:blipFill>` +
        `<p:spPr>` +
        `<a:xfrm><a:off x="914400" y="914400"/><a:ext cx="1828800" cy="1371600"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
        `<a:effectLst>` +
        `<a:outerShdw blurRad="50800" dist="38100" dir="2700000">` +
        `<a:srgbClr val="000000"/>` +
        `</a:outerShdw>` +
        `</a:effectLst>` +
        `</p:spPr>` +
        `</p:pic>` +
        `</p:spTree></p:cSld>` +
        `</p:sld>`;
      const slideRels =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>` +
        `</Relationships>`;

      const JSZip = (await import('https://esm.sh/jszip@3.10.1?bundle')).default;
      const zip = new JSZip();
      zip.file('ppt/presentation.xml', presentation);
      zip.file('ppt/_rels/presentation.xml.rels', presRels);
      zip.file('ppt/slides/slide1.xml', slide);
      zip.file('ppt/slides/_rels/slide1.xml.rels', slideRels);
      zip.file('ppt/media/image1.png', png1x1Red, { base64: true });
      const buf = await zip.generateAsync({ type: 'arraybuffer' });

      type W = {
        __casualSlides_getPptxClient: () => {
          import(file: ArrayBuffer, fileName: string): Promise<unknown>;
        };
      };
      return await (window as unknown as W).__casualSlides_getPptxClient().import(buf, 'wave9e-imgcolor.pptx');
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r: any = snapshot;
    const firstPage = r?.body?.pages?.[r?.body?.pageOrder?.[0]];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pic = Object.values(firstPage.pageElements ?? {}).find((e: any) => e.type === 1) as any;
    expect(pic, 'image element extracted').toBeTruthy();
    const ip = pic.image?.imageProperties;
    expect(ip, 'imageProperties present').toBeTruthy();
    // E5 — lum bright="20000" → 0.2; contrast="-10000" → -0.1.
    expect(ip.brightness, 'brightness +0.2').toBeCloseTo(0.2, 3);
    expect(ip.contrast, 'contrast -0.1').toBeCloseTo(-0.1, 3);
    expect(ip.grayscale, 'grayscale flag set').toBe(true);
    expect(ip.duotone, 'duotone hex pair').toBeTruthy();
    expect((ip.duotone[0] ?? '').toUpperCase().replace('#', '')).toBe('FF0000');
    expect((ip.duotone[1] ?? '').toUpperCase().replace('#', '')).toBe('0000FF');
    // E6 — effectLst shadow.
    expect(ip.effectLst, 'effectLst present').toBeTruthy();
    expect(ip.effectLst.outerShdw, 'outerShdw decoded').toBeTruthy();
    expect((ip.effectLst.outerShdw.color?.rgb ?? '').toUpperCase().replace('#', '')).toBe('000000');
    expect(ip.effectLst.outerShdw.blurRad).toBe(50800);
    expect(ip.effectLst.outerShdw.dist).toBe(38100);
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

  test('Toolbar → Layout dropdown inserts slide with template placeholders', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(400);

    // Capture initial slide count from the snapshot via Univer's API.
    const beforeCount = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = window as any;
      const univer = win.univer;
      const id = win.__casualSlides__IUniverInstanceService;
      const instances = univer.__getInjector().get(id);
      const model = instances.getCurrentUnitOfType(3 /* UniverInstanceType.UNIVER_SLIDE */);
      return model?.getSnapshot?.()?.body?.pageOrder?.length ?? 0;
    });

    // Click the toolbar Layout button → opens picker.
    await page.getByRole('button', { name: 'Layout' }).click();
    const picker = page.locator('[data-testid="layout-picker"]');
    await expect(picker).toBeVisible();

    // Pick "title-content" — should insert a slide with two text frames
    // (title + content). data-testid attribute on the tile button.
    await page.locator('[data-testid="layout-title-content"]').click();

    // Picker closes after pick.
    await expect(picker).toHaveCount(0);

    // Snapshot now has one more slide; the new slide carries our
    // placeholder text strings.
    await page.waitForFunction(
      (expected) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const win = window as any;
        const univer = win.univer;
        const id = win.__casualSlides__IUniverInstanceService;
        const instances = univer.__getInjector().get(id);
        const model = instances.getCurrentUnitOfType(3);
        return model?.getSnapshot?.()?.body?.pageOrder?.length === expected;
      },
      beforeCount + 1,
      { timeout: 5_000 },
    );

    const newSlideTexts: string[] = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = window as any;
      const univer = win.univer;
      const id = win.__casualSlides__IUniverInstanceService;
      const instances = univer.__getInjector().get(id);
      const model = instances.getCurrentUnitOfType(3);
      const snap = model?.getSnapshot?.();
      // The layout picker inserts after the active page; find by the
      // template's title field, not by tail-of-order.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pages = Object.values(snap?.body?.pages ?? {}) as any[];
      const newSlide = pages.find((p) => p?.title === 'Title + content');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const els = Object.values(newSlide?.pageElements ?? {}) as any[];
      return els
        .filter((e) => e.type === 2 /* TEXT */)
        .map((e) => e.richText?.text ?? '');
    });

    expect(newSlideTexts).toContain('Click to add title');
    expect(newSlideTexts).toContain('Click to add content');
  });

  test('Help → About shows version + license + dependencies', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => Array.isArray((window as { __capturedMutations?: unknown }).__capturedMutations),
      null,
      { timeout: 15_000 },
    );
    await page.waitForTimeout(300);

    // Open Help menu → About via the data-menu-item hook so we don't
    // accidentally match the dialog's own button labels.
    await page.getByRole('button', { name: 'Help' }).click();
    await page.locator('button[data-menu="help"][data-menu-item="about"]').click();

    const dialog = page.locator('[data-testid="about-dialog"]');
    await expect(dialog).toBeVisible();

    // Spot-check content: product name, license, repo URL, at least
    // one dependency attribution.
    await expect(dialog).toContainText('Casual Slides');
    await expect(dialog).toContainText('Apache-2.0');
    await expect(dialog).toContainText('github.com/schnsrw/slides');
    await expect(dialog).toContainText('Univer OSS');
    await expect(dialog).toContainText('PptxGenJS');

    // Esc closes.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
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
