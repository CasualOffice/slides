import { useEffect, useRef } from 'react';
import { ICommandService, IUniverInstanceService, LocaleType, LogLevel, Univer, UniverInstanceType } from '@univerjs/core';
import type { ISlideData, SlideDataModel } from '@univerjs/slides';
import { defaultTheme } from '@univerjs/themes';
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverUIPlugin } from '@univerjs/ui';
import { UniverDocsPlugin } from '@univerjs/docs';
import { UniverDocsUIPlugin } from '@univerjs/docs-ui';
import { UniverDrawingPlugin } from '@univerjs/drawing';
import { IRenderManagerService } from '@univerjs/engine-render';
import { UniverSlidesPlugin } from '@univerjs/slides';
import { SlideRenderController, UniverSlidesUIPlugin } from '@univerjs/slides-ui';

import { LOCALES } from './locale';

// Mount Univer Slides into a DOM container with a given snapshot. The
// component is keyed on `snapshot.id` from the parent — when the parent
// imports a new deck, it bumps the key and React unmounts + remounts the
// whole Univer instance with the new snapshot.
//
// Earlier we tried hot-swapping via disposeUnit + createUnit on the live
// Univer instance. That works for the data model but Univer's render
// manager doesn't re-attach a canvas to our container after disposeUnit;
// the symptom is "after Open .pptx the slide-bar thumbnails go empty and
// the main canvas vanishes entirely" — verified via the Playwright
// diagnostic at tests/e2e/__diagnostic__/open-pptx.spec.ts (canvases
// AFTER open: []).
//
// Remount costs ~hundreds of ms (locale composition + plugin lifecycle
// re-runs) but produces a correct render every time. Tracked as Gap 1.8
// — the proper fix is to either upstream the render-context rebind or
// expose a facade method that handles the lifecycle correctly.
export interface UniverSlideProps {
  snapshot: ISlideData;
}

export function UniverSlide({ snapshot }: UniverSlideProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const univer = new Univer({
      theme: defaultTheme,
      locale: LocaleType.EN_US,
      locales: LOCALES,
      logLevel: LogLevel.WARN,
    });

    // Render engine first — every other plugin assumes it exists.
    univer.registerPlugin(UniverRenderEnginePlugin);

    // Hide native chrome. We still must register UniverUIPlugin — it provides
    // the canvas mount, popup root, and keyboard scaffold.
    univer.registerPlugin(UniverUIPlugin, {
      container: containerRef.current,
      header: false,
      toolbar: false,
      footer: false,
      headerMenu: false,
      contextMenu: false,
    });

    // Docs + docs-ui are required for richText page elements (text frames are
    // backed by nested doc units). Formula engine is pulled in by docs anyway
    // — registering it explicitly keeps initialization order deterministic.
    univer.registerPlugin(UniverDocsPlugin);
    univer.registerPlugin(UniverDocsUIPlugin);
    univer.registerPlugin(UniverFormulaEnginePlugin);

    // Drawing plugin is required for image page elements.
    univer.registerPlugin(UniverDrawingPlugin);

    // Slides plugins last.
    univer.registerPlugin(UniverSlidesPlugin);
    univer.registerPlugin(UniverSlidesUIPlugin);

    univer.createUnit<ISlideData, SlideDataModel>(
      UniverInstanceType.UNIVER_SLIDE,
      snapshot,
    );

    if (typeof window !== 'undefined') {
      const w = window as unknown as {
        univer: Univer;
        __slideRevProbe?: () => number;
        __capturedMutations?: string[];
      };
      w.univer = univer;
      w.__capturedMutations = [];
      const cs = univer.__getInjector().get(ICommandService);
      cs.onMutationExecutedForCollab((info) => {
        w.__capturedMutations!.push(info.id);
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__casualSlides__ICommandService = ICommandService;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__casualSlides__IUniverInstanceService = IUniverInstanceService;

      // Expose the pptx export client so e2e tests can call
      // `exportSlidesToPptx` directly on a hand-built snapshot — needed
      // for image round-trip tests where we want to verify the produced
      // zip contains `ppt/media/*` entries.
      import('./pptx/client').then((m) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).__casualSlides_getPptxClient = m.getPptxClient;
      });

      // Spike-C runtime probe for the Gap 1 rev-tracking patch. Pre-patch
      // SlideDataModel.getRev() returned 0 forever and incrementRev was a
      // no-op. Post-patch it starts at 1 and bumps by one. Call from the
      // devtools console to verify.
      w.__slideRevProbe = () => {
        const instances = univer.__getInjector().get(IUniverInstanceService);
        const m = instances.getCurrentUnitOfType<SlideDataModel>(
          UniverInstanceType.UNIVER_SLIDE,
        );
        if (!m) return -1;
        const before = m.getRev();
        m.incrementRev();
        const after = m.getRev();
        // eslint-disable-next-line no-console
        console.info(`[slide-rev] before=${before} after=${after} (expected 1 → 2)`);
        return after;
      };
    }

    // Re-center the slide after our chrome (title bar + toolbar + status
    // bar) finishes laying out. Univer's SlideRenderController subscribes
    // to engine.onTransformChange$ for ONE scroll-to-center call at mount;
    // if that fires before the canvas has its final size (common in async
    // flex/grid layouts), the slide stays off-center and the user has to
    // scroll horizontally to find it.
    //
    // The public `scrollToCenter` we added to SlideRenderController lets
    // us re-run the math once layout settles — bound by a ResizeObserver
    // on the container so it also fires when the user resizes the window
    // or expands a sibling panel.
    const renderManager = univer.__getInjector().get(IRenderManagerService);
    const recenter = () => {
      const instances = univer.__getInjector().get(IUniverInstanceService);
      const unitId = instances.getCurrentUnitOfType(UniverInstanceType.UNIVER_SLIDE)?.getUnitId();
      if (!unitId) return;
      const renderUnit = renderManager.getRenderById(unitId);
      try {
        const ctrl = renderUnit?.with(SlideRenderController);
        // Trigger an engine resize first so canvasWidth/Height are fresh
        // before the centering math runs.
        renderUnit?.engine?.resize();
        ctrl?.scrollToCenter();
      } catch {
        /* renderUnit not ready yet — next tick will retry */
      }
    };

    // Chrome layout settles in a couple of frames. Fire on a short and a
    // longer delay so we catch both the initial mount and any late
    // font-load reflow.
    const t1 = window.setTimeout(recenter, 80);
    const t2 = window.setTimeout(recenter, 400);
    const t3 = window.setTimeout(recenter, 1200);

    // Container resize → re-center. Watches the .univer-mount element so
    // any change to the surrounding chrome (e.g. expanding a side panel)
    // triggers a fresh centering pass.
    const ro = new ResizeObserver(() => recenter());
    ro.observe(containerRef.current);

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      ro.disconnect();
      univer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="univer-mount" />;
}
