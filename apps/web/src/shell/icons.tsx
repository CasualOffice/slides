// Inline-SVG icon system for Casual Slides.
//
// Why inline SVG instead of an icon font:
//   - No webfont round-trip; no FOIT showing literal icon names (e.g.
//     "folder_open") if the font is slow or blocked.
//   - No emoji, no unicode shape chars; UI is fully glyph-free.
//   - The set is explicit and reviewable in one file — only icons we
//     actually use ship in the bundle.
//
// The path data below is copied from Lucide (MIT, https://lucide.dev).
// We intentionally do NOT depend on `lucide-react` to keep the bundle
// small and the icon set auditable.
//
// To add a new icon:
//   1. Find the icon on lucide.dev (or pick a closest match).
//   2. Copy its inner path/shape elements into `ICONS` keyed by the
//      Material Symbols-style name already used at the call site.
//   3. Use it: <Icon name="your_new_name" />.

import type { ReactNode } from 'react';

export interface IconProps {
  name: string;
  size?: number;
  filled?: boolean;
  className?: string;
}

// All children are rendered inside an <svg viewBox="0 0 24 24"> with
// stroke="currentColor", fill="none", strokeWidth=2, round joins/caps —
// matching Lucide's defaults. The map is keyed by the Material Symbols
// name we used previously so call sites don't need to change.
const ICONS: Record<string, ReactNode> = {
  // ----- file / share / I-O ----------------------------------------
  folder_open: (
    <path d="M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>
  ),
  print: (
    <>
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </>
  ),
  person_add: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <line x1="20" y1="8" x2="20" y2="14" />
      <line x1="23" y1="11" x2="17" y2="11" />
    </>
  ),

  // ----- history / undo / redo / clipboard -------------------------
  undo: (
    <>
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </>
  ),
  redo: (
    <>
      <polyline points="15 14 20 9 15 4" />
      <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
    </>
  ),
  history: (
    <>
      <path d="M3 3v5h5" />
      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
      <polyline points="12 7 12 12 16 14" />
    </>
  ),
  content_copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),

  // ----- tools / insert --------------------------------------------
  // arrow_selector_tool -> Lucide mouse-pointer-2
  arrow_selector_tool: (
    <path d="M4 4l7.07 17 2.51-7.39L21 11.07 4 4z" />
  ),
  // text_fields -> Lucide type
  text_fields: (
    <>
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </>
  ),
  // category -> Lucide shapes
  category: (
    <>
      <path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1z" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <circle cx="17.5" cy="17.5" r="3.5" />
    </>
  ),
  // horizontal_rule -> Lucide minus
  horizontal_rule: (
    <line x1="5" y1="12" x2="19" y2="12" />
  ),
  // add_comment -> Lucide message-square-plus
  add_comment: (
    <>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <line x1="12" y1="7" x2="12" y2="13" />
      <line x1="9" y1="10" x2="15" y2="10" />
    </>
  ),
  // add_to_photos -> Lucide copy-plus
  add_to_photos: (
    <>
      <line x1="15" y1="12" x2="15" y2="18" />
      <line x1="12" y1="15" x2="18" y2="15" />
      <rect x="8" y="8" width="14" height="14" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </>
  ),
  // view_compact -> Lucide layout-template
  view_compact: (
    <>
      <rect x="3" y="3" width="18" height="7" rx="1" />
      <rect x="3" y="14" width="9" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  palette: (
    <>
      <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
      <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z" />
    </>
  ),
  // format_color_fill -> Lucide paint-bucket
  format_color_fill: (
    <>
      <path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0L19 11Z" />
      <path d="m5 2 5 5" />
      <path d="M2 13h15" />
      <path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z" />
    </>
  ),
  // auto_awesome_motion -> Lucide sparkles
  auto_awesome_motion: (
    <>
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
      <path d="M4 17v2" />
      <path d="M5 18H3" />
    </>
  ),

  // ----- carets / arrows -------------------------------------------
  expand_more: <polyline points="6 9 12 15 18 9" />,
  chevron_left: <polyline points="15 18 9 12 15 6" />,
  chevron_right: <polyline points="9 18 15 12 9 6" />,
  // play_arrow -> Lucide play
  play_arrow: <polygon points="5 3 19 12 5 21 5 3" />,
  // arrow_right_alt -> Lucide arrow-right
  arrow_right_alt: (
    <>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </>
  ),
  // arrow_back -> Lucide arrow-left
  arrow_back: (
    <>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </>
  ),
  arrow_upward: (
    <>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </>
  ),
  arrow_downward: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </>
  ),

  // ----- shapes ----------------------------------------------------
  // change_history -> Lucide triangle
  change_history: (
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
  ),
  // diamond -> Lucide diamond (square rotated 45 in icon coords)
  diamond: (
    <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41L13.7 2.71a2.41 2.41 0 0 0-3.41 0z" />
  ),
  // pentagon -> Lucide pentagon
  pentagon: (
    <path d="M3.5 8.7c-.3.2-.5.6-.4 1l1.7 9.4c.1.5.5.9 1 .9h12.5c.5 0 .9-.4 1-.9l1.6-9.4c.1-.4-.1-.8-.4-1l-7.5-5.5c-.3-.3-.8-.3-1.2 0Z" />
  ),
  // hexagon -> Lucide hexagon
  hexagon: (
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
  ),
  // shape_line -> Lucide octagon (closest fit for "octagon" slot)
  shape_line: (
    <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
  ),
  // double_arrow -> Lucide chevron-right-circle-ish — use chevrons-right
  double_arrow: (
    <>
      <polyline points="7 17 12 12 7 7" />
      <polyline points="13 17 18 12 13 7" />
    </>
  ),
  add: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  star: (
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  ),
  rectangle: (
    <rect x="3" y="6" width="18" height="12" rx="1" />
  ),
  circle: (
    <circle cx="12" cy="12" r="9" />
  ),

  // ----- notes / sticky / panel ------------------------------------
  // sticky_note_2 -> Lucide sticky-note
  sticky_note_2: (
    <>
      <path d="M21 15a2 2 0 0 1-2 2h-4l-4 4v-4H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </>
  ),

  // ----- chrome / misc ---------------------------------------------
  close: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
  // view_agenda -> Lucide layout-list
  view_agenda: (
    <>
      <rect x="3" y="4" width="7" height="7" rx="1" />
      <rect x="3" y="13" width="7" height="7" rx="1" />
      <line x1="14" y1="6" x2="21" y2="6" />
      <line x1="14" y1="10" x2="21" y2="10" />
      <line x1="14" y1="15" x2="21" y2="15" />
      <line x1="14" y1="19" x2="21" y2="19" />
    </>
  ),
  // view_module -> Lucide layout-grid
  view_module: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  remove: <line x1="5" y1="12" x2="19" y2="12" />,
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </>
  ),
  // slideshow -> Lucide play-square-ish — use monitor-play
  slideshow: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <polygon points="10 8 16 10 10 14 10 8" fill="currentColor" stroke="none" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </>
  ),
  delete: (
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </>
  ),
  fullscreen: (
    <>
      <polyline points="3 9 3 3 9 3" />
      <polyline points="21 9 21 3 15 3" />
      <polyline points="3 15 3 21 9 21" />
      <polyline points="21 15 21 21 15 21" />
    </>
  ),
};

function pathFor(name: string): ReactNode {
  const node = ICONS[name];
  if (node) return node;
  // Fallback: square outline so missing icons are visible in dev.
  if (typeof console !== 'undefined') {
    // eslint-disable-next-line no-console
    console.warn(`[Icon] no SVG for "${name}" — rendering fallback square.`);
  }
  return <rect x="3" y="3" width="18" height="18" rx="2" />;
}

export function Icon({ name, size = 18, filled = false, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={filled ? 0 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`cs-icon ${className ?? ''}`}
      aria-hidden="true"
    >
      {pathFor(name)}
    </svg>
  );
}
