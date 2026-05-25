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
import { UniverSlidesPlugin } from '@univerjs/slides';
import { UniverSlidesUIPlugin } from '@univerjs/slides-ui';

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

    return () => {
      univer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} className="univer-mount" />;
}
