import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
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

import { DEFAULT_SLIDE_DATA } from './default-slide';
import { LOCALES } from './locale';

// Imperative handle exposed to the parent (App.tsx) so it can hot-swap the
// active deck (e.g. on `Open .pptx`) without unmounting the whole Univer
// instance — disposing + recreating the unit keeps the canvas warm.
export interface UniverSlideHandle {
  swapDeck(snapshot: ISlideData): void;
}

export const UniverSlide = forwardRef<UniverSlideHandle>(function UniverSlide(_, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const univerRef = useRef<Univer | null>(null);
  const activeUnitIdRef = useRef<string | null>(null);

  useImperativeHandle(ref, () => ({
    swapDeck(snapshot: ISlideData) {
      const univer = univerRef.current;
      if (!univer) return;
      const instances = univer.__getInjector().get(IUniverInstanceService);
      const oldUnitId = activeUnitIdRef.current;
      if (oldUnitId) {
        instances.disposeUnit(oldUnitId);
      }
      const model = univer.createUnit<ISlideData, SlideDataModel>(
        UniverInstanceType.UNIVER_SLIDE,
        snapshot,
      );
      activeUnitIdRef.current = model.getUnitId();
    },
  }), []);

  useEffect(() => {
    if (!containerRef.current) return;

    const univer = new Univer({
      theme: defaultTheme,
      locale: LocaleType.EN_US,
      // Without `locales`, the LocaleService throws on first plugin string
      // lookup and the canvas never renders. See ./locale.ts.
      locales: LOCALES,
      logLevel: LogLevel.WARN,
    });
    univerRef.current = univer;

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
    // — registering it explicitly here keeps initialization order deterministic.
    univer.registerPlugin(UniverDocsPlugin);
    univer.registerPlugin(UniverDocsUIPlugin);
    univer.registerPlugin(UniverFormulaEnginePlugin);

    // Drawing plugin is required for image page elements.
    univer.registerPlugin(UniverDrawingPlugin);

    // Slides plugins last.
    univer.registerPlugin(UniverSlidesPlugin);
    univer.registerPlugin(UniverSlidesUIPlugin);

    const model = univer.createUnit<ISlideData, SlideDataModel>(
      UniverInstanceType.UNIVER_SLIDE,
      DEFAULT_SLIDE_DATA,
    );
    activeUnitIdRef.current = model.getUnitId();

    if (typeof window !== 'undefined') {
      const w = window as unknown as {
        univer: Univer;
        __slideRevProbe?: () => number;
        __capturedMutations?: string[];
      };
      w.univer = univer;

      // Spike-mode collab probe: capture every CommandType.MUTATION the
      // engine fires through ICommandService.onMutationExecutedForCollab.
      // Lets Playwright (and dev console) verify Gap 2's refactor — that
      // slide element edits now route through MUTATION, not OPERATION.
      // Pre-patch this array stayed empty for SlideAddTextCommand;
      // post-patch it contains 'slide.mutation.insert-element'.
      w.__capturedMutations = [];
      const cs = univer.__getInjector().get(ICommandService);
      cs.onMutationExecutedForCollab((info) => {
        w.__capturedMutations!.push(info.id);
      });
      // Expose the ICommandService identifier on globalThis so the e2e
      // suite can grab the same service without importing the symbol.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__casualSlides__ICommandService = ICommandService;
      // Spike-C probe: confirms the Gap 1 rev-tracking patch is live at runtime.
      // Pre-patch this returned 0 forever; post-patch it starts at 1 and bumps
      // on every incrementRev(). Open devtools and call window.__slideRevProbe().
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
      univerRef.current = null;
      activeUnitIdRef.current = null;
    };
  }, []);

  return <div ref={containerRef} className="univer-mount" />;
});
