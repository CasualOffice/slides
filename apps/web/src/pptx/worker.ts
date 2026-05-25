/// <reference lib="webworker" />

import type { PptxErrorResult, PptxExportResult, PptxImportResult, PptxRequest, PptxResult } from './types';
import { exportSlidesToPptx } from './pptx-export';
import { importPptxToSlides } from './pptx-import';

// Worker entry. Keeps the heavy pptx work off the main thread — JSZip
// unzipping and PptxGenJS encoding both spend hundreds of ms on multi-MB
// decks and would otherwise freeze the UI.

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

function post(message: PptxResult, transfer: Transferable[] = []) {
  ctx.postMessage(message, transfer);
}

ctx.onmessage = async (event: MessageEvent<PptxRequest>) => {
  const req = event.data;
  try {
    if (req.type === 'export') {
      const blob = await exportSlidesToPptx(req.snapshot);
      const fileName = `${req.snapshot.title || 'Untitled deck'}.pptx`;
      const result: PptxExportResult = { type: 'export-result', id: req.id, blob, fileName };
      post(result);
      return;
    }
    if (req.type === 'import') {
      const snapshot = await importPptxToSlides(req.file, req.fileName);
      const result: PptxImportResult = { type: 'import-result', id: req.id, snapshot };
      post(result);
      return;
    }
    throw new Error(`unknown pptx worker request type: ${(req as { type: string }).type}`);
  } catch (err) {
    const error: PptxErrorResult = {
      type: 'error',
      id: req.id,
      message: err instanceof Error ? err.message : String(err),
    };
    post(error);
  }
};
