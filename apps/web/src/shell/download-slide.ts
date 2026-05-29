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

// Real print preview. Rasterizes every slide through the same offscreen
// SlideTile path the PNG/PDF exports use, then mounts an `@media print`
// sheet into the live document that hides the editor chrome and shows
// one image per slide with a page-break between them. `@page` sets the
// paper size to the slide's native aspect ratio so browsers' built-in
// print preview lays the deck out one slide per page with no margins or
// scaling. Beats the previous `window.print()` which printed the editor
// viewport (toolbar, slide panel, etc.) at 1:1.
export async function printDeck(
  pages: ISlidePage[],
  pageSize: { width: number; height: number },
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (!pages.length) return;
  const dataUrls: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    dataUrls.push(await rasterizeSlide(pages[i], pageSize));
    onProgress?.(i + 1, pages.length);
  }

  // Mount the print sheet into the live document. We keep it invisible
  // on screen via `@media screen { display: none }`; only `@media print`
  // makes it visible, while hiding everything else. Cleanup runs after
  // the print dialog closes.
  const STYLE_ID = 'cs-print-style';
  const ROOT_ID = 'cs-print-root';
  document.getElementById(STYLE_ID)?.remove();
  document.getElementById(ROOT_ID)?.remove();

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @media screen { #${ROOT_ID} { display: none; } }
    @media print {
      @page { size: ${pageSize.width}px ${pageSize.height}px; margin: 0; }
      html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
      body > *:not(#${ROOT_ID}) { display: none !important; }
      #${ROOT_ID} { display: block !important; position: static !important; }
      #${ROOT_ID} .cs-print-slide { page-break-after: always; break-after: page; width: ${pageSize.width}px; height: ${pageSize.height}px; overflow: hidden; }
      #${ROOT_ID} .cs-print-slide:last-child { page-break-after: auto; break-after: auto; }
      #${ROOT_ID} .cs-print-slide img { display: block; width: 100%; height: 100%; }
    }
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = ROOT_ID;
  for (const url of dataUrls) {
    const slide = document.createElement('div');
    slide.className = 'cs-print-slide';
    const img = document.createElement('img');
    img.src = url;
    slide.appendChild(img);
    root.appendChild(slide);
  }
  document.body.appendChild(root);

  const cleanup = () => {
    style.remove();
    root.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  // Give the images one paint frame to flush so the print dialog sees
  // them sized correctly.
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  window.print();
  // Safety net: some browsers don't fire `afterprint` when the dialog
  // is cancelled synchronously. Drop the sheet after a short delay so
  // the user never sees it on screen.
  window.setTimeout(cleanup, 1000);
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
