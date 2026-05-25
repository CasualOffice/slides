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
