import type { IPageElement, ISlideRichTextProps } from '@univerjs/slides';
import { PageElementType } from '@univerjs/slides';

// Slide-layout templates. Each layout defines a set of TEXT-type
// placeholders pre-positioned for a 960 × 540 px slide (matches Univer's
// default page size from DEFAULT_SLIDE_DATA). Picking a layout dispatches
// `slide.mutation.insert-page` with a fully-formed ISlidePage containing
// these elements pre-populated.
//
// We intentionally do NOT use OOXML placeholder semantics (`p:ph type`)
// because:
//   1. Our renderer doesn't yet honour layout/master placeholder
//      inheritance (I3 is import-only).
//   2. End users editing a fresh slide want concrete elements they can
//      click and replace — not invisible "click to add title" prompts
//      that vanish on focus.
// Each placeholder ships with the prompt text ("Click to add title") as
// the actual `richText.text`. Real authoring tools take a similar shortcut
// when their layout model doesn't yet support inheritance.

export interface LayoutTemplate {
  id: string;
  label: string;
  /** SVG-friendly mini preview of the layout (rendered in the picker). */
  preview: Array<{ x: number; y: number; w: number; h: number; kind: 'title' | 'body' }>;
  buildElements: () => Record<string, IPageElement>;
}

// Page size constants — keep in sync with `DEFAULT_SLIDE_DATA.pageSize`.
const PAGE_W = 960;
const PAGE_H = 540;

// Standard prompt text styles. fs is in pt; cl/rgb hex. The renderer
// reads these from the flat richText fields (wave-6 rich body would be
// the upgrade path; the flat fields keep the placeholder visible in any
// renderer state).
const titleStyle: Partial<ISlideRichTextProps> = { fs: 36, bl: 1, cl: { rgb: '#1F2937' } };
const subtitleStyle: Partial<ISlideRichTextProps> = { fs: 20, cl: { rgb: '#4B5563' } };
const headingStyle: Partial<ISlideRichTextProps> = { fs: 22, bl: 1, cl: { rgb: '#1F2937' } };
const bodyStyle: Partial<ISlideRichTextProps> = { fs: 16, cl: { rgb: '#374151' } };

let idCounter = 0;
function newElId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

function textEl(
  prefix: string,
  zIndex: number,
  left: number,
  top: number,
  width: number,
  height: number,
  text: string,
  style: Partial<ISlideRichTextProps>,
): IPageElement {
  return {
    id: newElId(prefix),
    zIndex,
    left,
    top,
    width,
    height,
    title: '',
    description: '',
    type: PageElementType.TEXT,
    richText: { text, ...style } as ISlideRichTextProps,
  };
}

function toMap(elements: IPageElement[]): Record<string, IPageElement> {
  const out: Record<string, IPageElement> = {};
  for (const el of elements) out[el.id] = el;
  return out;
}

export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  {
    id: 'blank',
    label: 'Blank',
    preview: [],
    buildElements: () => ({}),
  },
  {
    id: 'title-slide',
    label: 'Title slide',
    preview: [
      { x: 10, y: 38, w: 80, h: 14, kind: 'title' },
      { x: 20, y: 56, w: 60, h: 8, kind: 'body' },
    ],
    buildElements: () => toMap([
      textEl('title', 1, 80, 200, 800, 80, 'Click to add title', titleStyle),
      textEl('sub', 2, 160, 300, 640, 50, 'Click to add subtitle', subtitleStyle),
    ]),
  },
  {
    id: 'title-content',
    label: 'Title + content',
    preview: [
      { x: 6, y: 8, w: 88, h: 12, kind: 'title' },
      { x: 6, y: 26, w: 88, h: 60, kind: 'body' },
    ],
    buildElements: () => toMap([
      textEl('title', 1, 60, 50, 840, 70, 'Click to add title', titleStyle),
      textEl('body', 2, 60, 140, 840, 360, 'Click to add content', bodyStyle),
    ]),
  },
  {
    id: 'two-content',
    label: 'Two content',
    preview: [
      { x: 6, y: 8, w: 88, h: 12, kind: 'title' },
      { x: 6, y: 26, w: 42, h: 60, kind: 'body' },
      { x: 52, y: 26, w: 42, h: 60, kind: 'body' },
    ],
    buildElements: () => toMap([
      textEl('title', 1, 60, 50, 840, 70, 'Click to add title', titleStyle),
      textEl('body-l', 2, 60, 140, 400, 360, 'Click to add content', bodyStyle),
      textEl('body-r', 3, 500, 140, 400, 360, 'Click to add content', bodyStyle),
    ]),
  },
  {
    id: 'comparison',
    label: 'Comparison',
    preview: [
      { x: 6, y: 8, w: 88, h: 12, kind: 'title' },
      { x: 6, y: 24, w: 42, h: 8, kind: 'body' },
      { x: 52, y: 24, w: 42, h: 8, kind: 'body' },
      { x: 6, y: 36, w: 42, h: 50, kind: 'body' },
      { x: 52, y: 36, w: 42, h: 50, kind: 'body' },
    ],
    buildElements: () => toMap([
      textEl('title', 1, 60, 50, 840, 70, 'Click to add title', titleStyle),
      textEl('hd-l', 2, 60, 140, 400, 40, 'Heading', headingStyle),
      textEl('hd-r', 3, 500, 140, 400, 40, 'Heading', headingStyle),
      textEl('body-l', 4, 60, 200, 400, 300, 'Click to add content', bodyStyle),
      textEl('body-r', 5, 500, 200, 400, 300, 'Click to add content', bodyStyle),
    ]),
  },
  {
    id: 'section-header',
    label: 'Section header',
    preview: [
      { x: 10, y: 42, w: 80, h: 16, kind: 'title' },
    ],
    buildElements: () => toMap([
      textEl('title', 1, 80, 220, 800, 100, 'Section title', { fs: 44, bl: 1, cl: { rgb: '#1F2937' } }),
    ]),
  },
];

// Mint a fresh `ISlidePage` from a layout template. Caller dispatches it
// via `slide.mutation.insert-page` with an `index` to land in the right
// position (typically right after the active page).
export function buildPageFromLayout(template: LayoutTemplate, zIndex: number) {
  return {
    id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    pageType: 0, // PageType.SLIDE
    zIndex,
    title: template.label,
    description: '',
    pageBackgroundFill: { rgb: 'rgb(255, 255, 255)' },
    pageElements: template.buildElements(),
  };
}

export const PREVIEW_VIEWBOX = { w: 100, h: 60 } as const; // matches PAGE_W / PAGE_H aspect
export { PAGE_W, PAGE_H };
