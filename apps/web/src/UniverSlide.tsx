import { useEffect, useRef } from 'react';
import { IUniverInstanceService, LocaleType, LogLevel, Univer, UniverInstanceType } from '@univerjs/core';
import type { SlideDataModel } from '@univerjs/slides';
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

// Mount Univer Slides into a DOM container ref. Native UI chrome is hidden so
// we can render our own Office-style shell on top — same approach sheet uses
// (../sheet/apps/web/src/UniverSheet.tsx).
export function UniverSlide() {
  const containerRef = useRef<HTMLDivElement>(null);
  const disposedRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current) return;

    const univer = new Univer({
      theme: defaultTheme,
      locale: LocaleType.EN_US,
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
    // — registering it explicitly here keeps initialization order deterministic.
    univer.registerPlugin(UniverDocsPlugin);
    univer.registerPlugin(UniverDocsUIPlugin);
    univer.registerPlugin(UniverFormulaEnginePlugin);

    // Drawing plugin is required for image page elements.
    univer.registerPlugin(UniverDrawingPlugin);

    // Slides plugins last.
    univer.registerPlugin(UniverSlidesPlugin);
    univer.registerPlugin(UniverSlidesUIPlugin);

    univer.createUnit(UniverInstanceType.UNIVER_SLIDE, DEFAULT_SLIDE_DATA);

    if (typeof window !== 'undefined') {
      const w = window as unknown as { univer: Univer; __slideRevProbe?: () => number };
      w.univer = univer;
      // Spike-C probe: confirms the Gap 1 rev-tracking patch is live at runtime.
      // Pre-patch this returned 0 forever; post-patch it starts at 1 and bumps
      // on every incrementRev(). Open devtools and call window.__slideRevProbe().
      w.__slideRevProbe = () => {
        const instances = univer.__getInjector().get(IUniverInstanceService);
        const model = instances.getCurrentUnitOfType<SlideDataModel>(
          UniverInstanceType.UNIVER_SLIDE,
        );
        if (!model) return -1;
        const before = model.getRev();
        model.incrementRev();
        const after = model.getRev();
        // eslint-disable-next-line no-console
        console.info(`[slide-rev] before=${before} after=${after} (expected 1 → 2)`);
        return after;
      };
    }

    return () => {
      disposedRef.current = true;
      univer.dispose();
    };
  }, []);

  return <div ref={containerRef} className="univer-mount" />;
}
