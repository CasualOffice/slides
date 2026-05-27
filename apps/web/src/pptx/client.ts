import type { ISlideData } from '@univerjs/slides';
import type {
  PptxExportRequest,
  PptxExportResult,
  PptxImportRequest,
  PptxImportResult,
  PptxRequest,
  PptxResult,
} from './types';
import { loadFontsForSnapshot } from './fonts-loader';

// Main-thread client for the pptx Web Worker. Hides the request/response
// correlation behind a Promise per call.
//
// One worker instance is shared across calls — JSZip + PptxGenJS modules
// stay loaded between exports. Disposed via dispose().

class PptxClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (result: PptxResult) => void; reject: (err: Error) => void }>();

  private getWorker(): Worker {
    if (!this.worker) {
      // Vite resolves new Worker(new URL(..., import.meta.url)) at build time
      // and emits a hashed worker bundle. `{ type: 'module' }` is required
      // for ES-module workers (vite.config.ts pins worker.format = 'es').
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (event: MessageEvent<PptxResult>) => {
        const msg = event.data;
        const handler = this.pending.get(msg.id);
        if (!handler) return;
        this.pending.delete(msg.id);
        if (msg.type === 'error') {
          handler.reject(new Error(msg.message));
        } else {
          handler.resolve(msg);
        }
      };
      this.worker.onerror = (event) => {
        const err = new Error(event.message || 'pptx worker error');
        for (const { reject } of this.pending.values()) reject(err);
        this.pending.clear();
      };
    }
    return this.worker;
  }

  private send<TReq extends PptxRequest, TRes extends PptxResult>(
    req: Omit<TReq, 'id'>,
    transfer: Transferable[] = [],
  ): Promise<TRes> {
    const id = this.nextId++;
    return new Promise<TRes>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (msg) => resolve(msg as TRes),
        reject,
      });
      this.getWorker().postMessage({ ...req, id } as TReq, transfer);
    });
  }

  async export(snapshot: ISlideData): Promise<{ blob: Blob; fileName: string }> {
    const result = await this.send<PptxExportRequest, PptxExportResult>({ type: 'export', snapshot });
    return { blob: result.blob, fileName: result.fileName };
  }

  async import(file: ArrayBuffer, fileName: string): Promise<ISlideData> {
    const result = await this.send<PptxImportRequest, PptxImportResult>(
      { type: 'import', file, fileName },
      // Transfer the buffer so we don't pay the copy cost on large decks.
      [file],
    );
    // Font loading has to happen on the MAIN thread — `document` is
    // not defined inside the pptx worker, so calling the loader inside
    // importPptxToSlides was a silent no-op. Scan the returned
    // snapshot for every distinct family, inject Google Fonts links,
    // and BLOCK until the requested faces are actually loaded.
    // Without this block, Univer's documentSkeleton lays out using
    // whatever font is available at the moment (usually system Arial
    // fallback); the canvas later repaints with the real face but the
    // skeleton's line-wrap counts were computed with the wrong glyph
    // widths, leaving text overflowing or under-filling the frame.
    let requested: Set<string> = new Set();
    try { requested = loadFontsForSnapshot(result.snapshot); } catch { /* ignore */ }
    if (typeof document !== 'undefined' && (document as Document & { fonts?: FontFaceSet }).fonts && requested.size > 0) {
      const fonts = (document as Document & { fonts: FontFaceSet }).fonts;
      // Ask the FontFaceSet to actively load each family at 16 px in
      // 400 + 700 weight. The set caches faces it has already pulled
      // and otherwise downloads them, fulfilling once the bytes are
      // ready. `fonts.ready` alone is unreliable because a freshly
      // injected <link> doesn't transition the set into the
      // 'loading' state until the CSS finishes parsing — racing the
      // first paint.
      const loaders: Promise<unknown>[] = [];
      for (const family of requested) {
        // CSS expects quoted family names that contain spaces.
        const css = family.includes(' ') ? `"${family}"` : family;
        loaders.push(fonts.load(`400 16px ${css}`).catch(() => null));
        loaders.push(fonts.load(`700 16px ${css}`).catch(() => null));
      }
      await Promise.race([
        Promise.all(loaders),
        new Promise<void>((r) => setTimeout(r, 3_000)),
      ]).catch(() => {});
    }
    return result.snapshot;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
  }
}

// Module-scoped singleton — re-used across renders to keep the worker warm.
let singleton: PptxClient | null = null;

export function getPptxClient(): PptxClient {
  if (!singleton) singleton = new PptxClient();
  return singleton;
}
