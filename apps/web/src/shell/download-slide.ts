import * as ReactDOM from 'react-dom/client';
import { createElement } from 'react';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import type { ISlidePage } from '@univerjs/slides';
import { SlideTile } from './SlideTile';

// Render a SlideTile offscreen, rasterize it via html-to-image, and trigger a
// PNG download. The Tile is mounted into a hidden container at native px so
// the rasterizer captures the slide exactly as the editor displays it — same
// renderer the slideshow/presenter use. No dependency on the Univer canvas
// (which is GPU-backed; pulling pixels from it would need an export API we
// don't have).

function safeFileName(name: string, suffix: string, ext: string): string {
  const base = (name || 'slide').trim().replace(/[\\/:*?"<>|]+/g, '_');
  return `${base}${suffix}.${ext}`;
}

function downloadDataUrl(dataUrl: string, fileName: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// Render a single SlideTile offscreen and return the rasterized data URL.
// Shared between the per-slide PNG export and the deck PDF export — keeping
// one rasterizer means the two outputs stay visually identical.
async function rasterizeSlide(
  page: ISlidePage,
  pageSize: { width: number; height: number },
): Promise<string> {
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.width = `${pageSize.width}px`;
  host.style.height = `${pageSize.height}px`;
  host.style.pointerEvents = 'none';
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);

  const root = ReactDOM.createRoot(host);
  root.render(createElement(SlideTile, { page, pageSize }));

  try {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    if (document.fonts?.ready) {
      await document.fonts.ready.catch(() => {});
    }
    await new Promise<void>((r) => setTimeout(r, 60));

    const target = host.firstElementChild as HTMLElement | null;
    if (!target) throw new Error('rasterizeSlide: no target element');

    return await toPng(target, {
      width: pageSize.width,
      height: pageSize.height,
      pixelRatio: 2,
      cacheBust: false,
      backgroundColor: '#ffffff',
      skipFonts: false,
    });
  } finally {
    root.unmount();
    host.remove();
  }
}

export async function downloadSlideAsPng(
  page: ISlidePage,
  pageSize: { width: number; height: number },
  fileName: string,
  slideNumber: number,
): Promise<void> {
  const dataUrl = await rasterizeSlide(page, pageSize);
  downloadDataUrl(dataUrl, safeFileName(fileName, `-slide-${slideNumber}`, 'png'));
}

// Multi-slide PDF export. Each page is rasterized via the same offscreen
// SlideTile path the PNG export uses, then dropped into a single jsPDF
// document at the slide's native point size (1 px → 1 pt at 96 DPI so the
// PDF page geometry matches the deck's aspect ratio exactly).
//
// We render slides sequentially rather than in parallel — each rasterize
// spins up a React root + ResizeObserver waits, so doing them serially
// keeps memory bounded and the on-screen UI responsive.
export async function downloadDeckAsPdf(
  pages: ISlidePage[],
  pageSize: { width: number; height: number },
  fileName: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (!pages.length) return;
  const orientation: 'landscape' | 'portrait' =
    pageSize.width >= pageSize.height ? 'landscape' : 'portrait';
  const pdf = new jsPDF({
    orientation,
    unit: 'pt',
    format: [pageSize.width, pageSize.height],
    compress: true,
  });
  for (let i = 0; i < pages.length; i++) {
    const dataUrl = await rasterizeSlide(pages[i], pageSize);
    if (i > 0) pdf.addPage([pageSize.width, pageSize.height], orientation);
    pdf.addImage(dataUrl, 'PNG', 0, 0, pageSize.width, pageSize.height, undefined, 'FAST');
    onProgress?.(i + 1, pages.length);
  }
  pdf.save(safeFileName(fileName, '', 'pdf'));
}
