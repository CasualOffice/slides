import { useMemo } from 'react';
import type { IPageElement, ISlidePage } from '@univerjs/slides';
import { PageElementType } from '@univerjs/slides';

// SlideTile — DOM-only renderer for a single slide page.
//
// Extracted from SlideShow.tsx so the same primitive can power both the
// main full-size presenter tile and the smaller "next slide" thumbnail
// in PresenterView. Pure read-only output — no Univer instance and no
// editor chrome. Fidelity is a strict subset of Univer's canvas:
//
//   - slide background fill
//   - text elements with size/colour/bold/italic/underline
//   - basic shapes (rect/ellipse) with fill colour
//   - images via base64Cache or contentUrl
//
// Geometry is laid out in the slide's native px coordinates inside a
// box sized to `pageSize`. Consumers scale the wrapper externally (CSS
// transform, max-width/height, etc.).

export interface SlideTileProps {
  page: ISlidePage;
  pageSize: { width: number; height: number };
  className?: string;
}

// Univer's Nullable<T> includes `void`; widen the accept type.
function rgbToCss(rgb: string | null | undefined | void, fallback = '#ffffff'): string {
  if (!rgb) return fallback;
  return rgb.trim();
}

function renderTextElement(element: IPageElement) {
  const rt = element.richText;
  if (!rt?.text) return null;
  return (
    <div
      key={element.id}
      style={{
        position: 'absolute',
        left: element.left,
        top: element.top,
        width: element.width,
        height: element.height,
        fontSize: rt.fs ? `${rt.fs}px` : '24px',
        color: rgbToCss(rt.cl?.rgb, '#111827'),
        fontWeight: rt.bl ? 700 : 400,
        fontStyle: rt.it ? 'italic' : 'normal',
        textDecoration: rt.ul ? 'underline' : 'none',
        whiteSpace: 'pre-wrap',
        lineHeight: 1.2,
        overflow: 'hidden',
      }}
    >
      {rt.text}
    </div>
  );
}

function renderShapeElement(element: IPageElement) {
  const shape = element.shape;
  if (!shape) return null;
  const isEllipse = shape.shapeType === 'ellipse';
  return (
    <div
      key={element.id}
      style={{
        position: 'absolute',
        left: element.left,
        top: element.top,
        width: element.width,
        height: element.height,
        background: rgbToCss(shape.shapeProperties?.shapeBackgroundFill?.rgb, '#e2e8f0'),
        borderRadius: isEllipse ? '50%' : (shape.shapeProperties?.radius ?? 0),
      }}
    />
  );
}

function renderImageElement(element: IPageElement) {
  const img = element.image;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = img?.imageProperties as any;
  const src: string | undefined = props?.contentUrl || props?.base64Cache;
  if (!src) return null;
  return (
    <img
      key={element.id}
      src={src}
      alt=""
      style={{
        position: 'absolute',
        left: element.left,
        top: element.top,
        width: element.width,
        height: element.height,
        objectFit: 'contain',
      }}
    />
  );
}

function renderElement(element: IPageElement) {
  if (element.type === PageElementType.TEXT) return renderTextElement(element);
  if (element.type === PageElementType.SHAPE) return renderShapeElement(element);
  if (element.type === PageElementType.IMAGE) return renderImageElement(element);
  return null;
}

export function SlideTile({ page, pageSize, className }: SlideTileProps) {
  const elements = useMemo(
    () =>
      Object.values(page.pageElements ?? {}).sort(
        (a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0),
      ),
    [page.pageElements],
  );
  return (
    <div
      className={`cs-slideshow__slide ${className ?? ''}`}
      style={{
        width: pageSize.width,
        height: pageSize.height,
        background: rgbToCss(page.pageBackgroundFill?.rgb, '#ffffff'),
      }}
    >
      {elements.map(renderElement)}
    </div>
  );
}
