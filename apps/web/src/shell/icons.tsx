// Inline SVG icon component.
//
// Every icon is a tuple of <outlined, filled?> SVG bodies rendered inside
// a 24×24 viewBox. The `filled` prop on a call site picks the filled
// variant when available — used for toolbar toggle "selected" states
// (Bold/Italic/Underline/Strikethrough, alignment, list mode, etc.).
// Icons without a filled variant fall back to the outlined one.
//
// Geometry follows Lucide outline (MIT) at stroke-width 2, line-cap/join
// round. Filled variants use `fill="currentColor"` with no stroke, so the
// icon renders as a solid silhouette in the same colour. No webfont, no
// emoji, no text fallback — if a name isn't in the map, the user sees a
// neutral square placeholder (never a string of text) and a dev console
// warning.

import { useEffect, useRef } from 'react';

export interface IconProps {
  name: string;
  size?: number;
  filled?: boolean;
  className?: string;
}

type IconBody = JSX.Element | { outlined: JSX.Element; filled?: JSX.Element };

const ICONS: Record<string, IconBody> = {
  // ── chrome / actions ──────────────────────────────────────────────
  folder_open: {
    outlined: (
      <>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1" />
        <path d="m3 9 1.5 9A2 2 0 0 0 6.5 20h11a2 2 0 0 0 2-1.5L21 9z" />
      </>
    ),
  },
  download: {
    outlined: (
      <>
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M4 21h16" />
      </>
    ),
  },
  print: {
    outlined: (
      <>
        <path d="M6 9V3h12v6" />
        <rect x="6" y="13" width="12" height="8" rx="1" />
        <path d="M6 17H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" />
      </>
    ),
  },
  close: {
    outlined: (
      <>
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </>
    ),
  },
  check: {
    outlined: <polyline points="20 6 9 17 4 12" />,
  },
  add: {
    outlined: (
      <>
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </>
    ),
  },
  remove: { outlined: <line x1="5" y1="12" x2="19" y2="12" /> },
  expand_more: { outlined: <polyline points="6 9 12 15 18 9" /> },
  chevron_left: { outlined: <polyline points="15 18 9 12 15 6" /> },
  chevron_right: { outlined: <polyline points="9 18 15 12 9 6" /> },
  more_vert: {
    outlined: (
      <>
        <circle cx="12" cy="6" r="1.4" />
        <circle cx="12" cy="12" r="1.4" />
        <circle cx="12" cy="18" r="1.4" />
      </>
    ),
    filled: (
      <>
        <circle cx="12" cy="6" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="12" cy="18" r="1.6" fill="currentColor" stroke="none" />
      </>
    ),
  },
  search: {
    outlined: (
      <>
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.5" y2="16.5" />
      </>
    ),
  },
  history: {
    outlined: (
      <>
        <path d="M3 12a9 9 0 1 0 3-6.7" />
        <polyline points="3 4 3 10 9 10" />
        <polyline points="12 7 12 12 16 14" />
      </>
    ),
  },
  info: {
    outlined: (
      <>
        <circle cx="12" cy="12" r="9" />
        <line x1="12" y1="11" x2="12" y2="17" />
        <circle cx="12" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
      </>
    ),
  },
  error: {
    outlined: (
      <>
        <circle cx="12" cy="12" r="9" />
        <line x1="12" y1="7" x2="12" y2="13" />
        <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
      </>
    ),
  },
  keyboard: {
    outlined: (
      <>
        <rect x="2" y="6" width="20" height="12" rx="2" />
        <line x1="6" y1="10" x2="6.01" y2="10" />
        <line x1="10" y1="10" x2="10.01" y2="10" />
        <line x1="14" y1="10" x2="14.01" y2="10" />
        <line x1="18" y1="10" x2="18.01" y2="10" />
        <line x1="7" y1="14" x2="17" y2="14" />
      </>
    ),
  },
  fullscreen: {
    outlined: (
      <>
        <polyline points="4 9 4 4 9 4" />
        <polyline points="20 9 20 4 15 4" />
        <polyline points="4 15 4 20 9 20" />
        <polyline points="20 15 20 20 15 20" />
      </>
    ),
  },
  person_add: {
    outlined: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <line x1="19" y1="8" x2="19" y2="14" />
        <line x1="22" y1="11" x2="16" y2="11" />
      </>
    ),
  },

  // ── undo / redo ────────────────────────────────────────────────────
  undo: {
    outlined: (
      <>
        <polyline points="9 14 4 9 9 4" />
        <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
      </>
    ),
  },
  redo: {
    outlined: (
      <>
        <polyline points="15 14 20 9 15 4" />
        <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
      </>
    ),
  },

  // ── slide / view modes ────────────────────────────────────────────
  add_to_photos: {
    outlined: (
      <>
        <rect x="3" y="3" width="14" height="14" rx="2" />
        <path d="M7 21h12a2 2 0 0 0 2-2V9" />
        <line x1="10" y1="10" x2="10" y2="14" />
        <line x1="8" y1="12" x2="12" y2="12" />
      </>
    ),
  },
  content_copy: {
    outlined: (
      <>
        <rect x="9" y="9" width="12" height="12" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </>
    ),
  },
  delete: {
    outlined: (
      <>
        <polyline points="3 6 5 6 21 6" />
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        <path d="M10 11v6M14 11v6" />
        <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      </>
    ),
  },
  view_agenda: {
    outlined: (
      <>
        <rect x="3" y="4" width="18" height="7" rx="1" />
        <rect x="3" y="13" width="18" height="7" rx="1" />
      </>
    ),
    filled: (
      <>
        <rect x="3" y="4" width="18" height="7" rx="1" fill="currentColor" stroke="none" />
        <rect x="3" y="13" width="18" height="7" rx="1" fill="currentColor" stroke="none" />
      </>
    ),
  },
  view_module: {
    outlined: (
      <>
        <rect x="3" y="4" width="7" height="7" rx="1" />
        <rect x="14" y="4" width="7" height="7" rx="1" />
        <rect x="3" y="13" width="7" height="7" rx="1" />
        <rect x="14" y="13" width="7" height="7" rx="1" />
      </>
    ),
  },
  view_compact: {
    outlined: (
      <>
        <rect x="3" y="4" width="18" height="6" rx="1" />
        <rect x="3" y="12" width="8" height="8" rx="1" />
        <rect x="13" y="12" width="8" height="8" rx="1" />
      </>
    ),
  },
  sticky_note_2: {
    outlined: (
      <>
        <path d="M4 4h10l6 6v10a2 2 0 0 1-2 2H4z" />
        <polyline points="14 4 14 10 20 10" />
      </>
    ),
    filled: (
      <>
        <path
          d="M4 4h10l6 6v10a2 2 0 0 1-2 2H4z"
          fill="currentColor"
          stroke="none"
        />
        <path d="M14 4v6h6" fill="rgba(255,255,255,0.35)" stroke="none" />
      </>
    ),
  },
  slideshow: {
    outlined: (
      <>
        <rect x="2" y="4" width="20" height="14" rx="2" />
        <polygon points="10 9 16 11.5 10 14" fill="currentColor" stroke="none" />
        <line x1="8" y1="22" x2="16" y2="22" />
      </>
    ),
  },
  play_arrow: {
    outlined: <polygon points="6 4 20 12 6 20" fill="currentColor" stroke="none" />,
    filled: <polygon points="6 4 20 12 6 20" fill="currentColor" stroke="none" />,
  },

  // ── insert ─────────────────────────────────────────────────────────
  text_fields: {
    outlined: (
      <>
        <polyline points="4 7 4 4 20 4 20 7" />
        <line x1="9" y1="20" x2="15" y2="20" />
        <line x1="12" y1="4" x2="12" y2="20" />
      </>
    ),
  },
  image: {
    outlined: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </>
    ),
  },
  category: {
    outlined: (
      <>
        <polygon points="12 3 4 11 12 11" />
        <rect x="13" y="13" width="8" height="8" rx="1" />
        <circle cx="7" cy="17" r="3.5" />
      </>
    ),
  },
  horizontal_rule: { outlined: <line x1="4" y1="12" x2="20" y2="12" /> },
  add_comment: {
    outlined: (
      <>
        <path d="M21 11a8 8 0 0 1-8 8H7l-4 3V11a8 8 0 0 1 16 0Z" />
        <line x1="12" y1="8" x2="12" y2="14" />
        <line x1="9" y1="11" x2="15" y2="11" />
      </>
    ),
  },
  arrow_selector_tool: {
    outlined: (
      <>
        <path d="M4 4l7 18 2-8 8-2z" />
      </>
    ),
  },

  // ── shapes ─────────────────────────────────────────────────────────
  rectangle: { outlined: <rect x="3" y="6" width="18" height="12" rx="1" /> },
  circle: { outlined: <circle cx="12" cy="12" r="9" /> },
  change_history: { outlined: <polygon points="12 4 22 20 2 20" /> },
  diamond: { outlined: <polygon points="12 2 22 12 12 22 2 12" /> },
  pentagon: { outlined: <polygon points="12 3 22 10 18 21 6 21 2 10" /> },
  hexagon: { outlined: <polygon points="6 3 18 3 22 12 18 21 6 21 2 12" /> },
  shape_line: { outlined: <polygon points="12 2 21 8 21 16 12 22 3 16 3 8" /> },
  star: {
    outlined: (
      <polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9" />
    ),
  },
  double_arrow: {
    outlined: (
      <>
        <polyline points="4 6 10 12 4 18" />
        <polyline points="12 6 18 12 12 18" />
      </>
    ),
  },
  arrow_right_alt: {
    outlined: (
      <>
        <line x1="3" y1="12" x2="20" y2="12" />
        <polyline points="15 7 20 12 15 17" />
      </>
    ),
  },
  arrow_back: {
    outlined: (
      <>
        <line x1="21" y1="12" x2="4" y2="12" />
        <polyline points="9 7 4 12 9 17" />
      </>
    ),
  },
  arrow_upward: {
    outlined: (
      <>
        <line x1="12" y1="20" x2="12" y2="4" />
        <polyline points="6 10 12 4 18 10" />
      </>
    ),
  },
  arrow_downward: {
    outlined: (
      <>
        <line x1="12" y1="4" x2="12" y2="20" />
        <polyline points="6 14 12 20 18 14" />
      </>
    ),
  },

  // ── slide tools ────────────────────────────────────────────────────
  palette: {
    outlined: (
      <>
        <path d="M12 3a9 9 0 1 0 4 17 2 2 0 0 0 0-4h-1.5a1.5 1.5 0 0 1 0-3H17a4 4 0 0 0 4-4c0-3.6-4-6-9-6Z" />
        <circle cx="7.5" cy="11.5" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="11" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="15.5" cy="8.5" r="1.2" fill="currentColor" stroke="none" />
      </>
    ),
  },
  format_color_fill: {
    outlined: (
      <>
        <path d="M7 4 4 7l8 8 8-8-3-3-5 5-5-5z" />
        <path d="M5 18a3 3 0 0 0 6 0c0-2-3-5-3-5s-3 3-3 5z" />
      </>
    ),
  },
  format_color_text: {
    outlined: (
      <>
        <path d="M6 18 12 4l6 14" />
        <line x1="8" y1="14" x2="16" y2="14" />
        <rect x="5" y="20" width="14" height="2" fill="currentColor" stroke="none" />
      </>
    ),
  },
  border_color: {
    outlined: (
      <>
        <path d="M14 4 3 15v5h5L19 9z" />
        <line x1="14" y1="4" x2="20" y2="10" />
        <rect x="3" y="21" width="18" height="2" fill="currentColor" stroke="none" />
      </>
    ),
  },
  auto_awesome_motion: {
    outlined: (
      <>
        <rect x="3" y="9" width="12" height="12" rx="1" />
        <path d="M7 5h12a1 1 0 0 1 1 1v12" />
        <path d="M11 1h8a1 1 0 0 1 1 1v8" />
      </>
    ),
  },

  // ── format toggles ─────────────────────────────────────────────────
  bold: {
    outlined: (
      <>
        <path d="M7 4h7a4 4 0 0 1 0 8H7zM7 12h8a4 4 0 0 1 0 8H7z" />
      </>
    ),
    filled: (
      <path
        d="M7 4h7a4 4 0 0 1 0 8H7zM7 12h8a4 4 0 0 1 0 8H7z"
        fill="currentColor"
        stroke="none"
      />
    ),
  },
  italic: {
    outlined: (
      <>
        <line x1="19" y1="4" x2="10" y2="4" />
        <line x1="14" y1="20" x2="5" y2="20" />
        <line x1="15" y1="4" x2="9" y2="20" />
      </>
    ),
    filled: (
      <path
        d="M10 4h9v2.4h-3.6L11.8 17.6H15V20H6v-2.4h3.6L13.2 6.4H10z"
        fill="currentColor"
        stroke="none"
      />
    ),
  },
  underline: {
    outlined: (
      <>
        <path d="M6 4v6a6 6 0 0 0 12 0V4" />
        <line x1="4" y1="20" x2="20" y2="20" />
      </>
    ),
    filled: (
      <>
        <path d="M6 4v6a6 6 0 0 0 12 0V4" fill="currentColor" stroke="none" />
        <rect x="4" y="19" width="16" height="2" fill="currentColor" stroke="none" />
      </>
    ),
  },
  strikethrough: {
    outlined: (
      <>
        <path d="M16 4H9a3 3 0 0 0-2.83 4" />
        <path d="M14 12a4 4 0 0 1 0 8H6" />
        <line x1="4" y1="12" x2="20" y2="12" />
      </>
    ),
    filled: (
      <>
        <path d="M16 4H9a3 3 0 0 0-2.83 4" stroke="currentColor" />
        <path d="M14 12a4 4 0 0 1 0 8H6" stroke="currentColor" />
        <rect x="4" y="11" width="16" height="2" fill="currentColor" stroke="none" />
      </>
    ),
  },
  format_clear: {
    outlined: (
      <>
        <path d="M4 7h6m4 0h6" />
        <path d="M10 4v4l-4 12" />
        <path d="m14 4-2 6" />
        <line x1="4" y1="20" x2="20" y2="20" />
        <line x1="3" y1="3" x2="21" y2="21" />
      </>
    ),
  },

  // ── paragraph alignment ───────────────────────────────────────────
  format_align_left: {
    outlined: (
      <>
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="15" y2="12" />
        <line x1="3" y1="18" x2="18" y2="18" />
      </>
    ),
    filled: (
      <>
        <rect x="3" y="5" width="18" height="2.4" fill="currentColor" stroke="none" />
        <rect x="3" y="11" width="12" height="2.4" fill="currentColor" stroke="none" />
        <rect x="3" y="17" width="15" height="2.4" fill="currentColor" stroke="none" />
      </>
    ),
  },
  format_align_center: {
    outlined: (
      <>
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="6" y1="12" x2="18" y2="12" />
        <line x1="4" y1="18" x2="20" y2="18" />
      </>
    ),
    filled: (
      <>
        <rect x="3" y="5" width="18" height="2.4" fill="currentColor" stroke="none" />
        <rect x="6" y="11" width="12" height="2.4" fill="currentColor" stroke="none" />
        <rect x="4" y="17" width="16" height="2.4" fill="currentColor" stroke="none" />
      </>
    ),
  },
  format_align_right: {
    outlined: (
      <>
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="9" y1="12" x2="21" y2="12" />
        <line x1="6" y1="18" x2="21" y2="18" />
      </>
    ),
    filled: (
      <>
        <rect x="3" y="5" width="18" height="2.4" fill="currentColor" stroke="none" />
        <rect x="9" y="11" width="12" height="2.4" fill="currentColor" stroke="none" />
        <rect x="6" y="17" width="15" height="2.4" fill="currentColor" stroke="none" />
      </>
    ),
  },
  format_align_justify: {
    outlined: (
      <>
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </>
    ),
    filled: (
      <>
        <rect x="3" y="5" width="18" height="2.4" fill="currentColor" stroke="none" />
        <rect x="3" y="11" width="18" height="2.4" fill="currentColor" stroke="none" />
        <rect x="3" y="17" width="18" height="2.4" fill="currentColor" stroke="none" />
      </>
    ),
  },

  // ── lists ─────────────────────────────────────────────────────────
  format_list_bulleted: {
    outlined: (
      <>
        <circle cx="5" cy="6" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="5" cy="18" r="1.2" fill="currentColor" stroke="none" />
        <line x1="9" y1="6" x2="20" y2="6" />
        <line x1="9" y1="12" x2="20" y2="12" />
        <line x1="9" y1="18" x2="20" y2="18" />
      </>
    ),
    filled: (
      <>
        <circle cx="5" cy="6" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="5" cy="18" r="1.6" fill="currentColor" stroke="none" />
        <rect x="9" y="5" width="12" height="2.2" fill="currentColor" stroke="none" />
        <rect x="9" y="11" width="12" height="2.2" fill="currentColor" stroke="none" />
        <rect x="9" y="17" width="12" height="2.2" fill="currentColor" stroke="none" />
      </>
    ),
  },
  format_list_numbered: {
    outlined: (
      <>
        <line x1="9" y1="6" x2="20" y2="6" />
        <line x1="9" y1="12" x2="20" y2="12" />
        <line x1="9" y1="18" x2="20" y2="18" />
        <path d="M4 4v4h2" />
        <path d="M4 12h3a1 1 0 0 1 1 1v1l-3 2v0h3" />
        <path d="M5 18h2a1 1 0 0 1 0 2H5m0 0h2a1 1 0 0 0 0-2H5" />
      </>
    ),
    filled: (
      <>
        <rect x="9" y="5" width="12" height="2.2" fill="currentColor" stroke="none" />
        <rect x="9" y="11" width="12" height="2.2" fill="currentColor" stroke="none" />
        <rect x="9" y="17" width="12" height="2.2" fill="currentColor" stroke="none" />
        <path d="M4 4v4h2" stroke="currentColor" />
        <path d="M4 12h3a1 1 0 0 1 1 1v1l-3 2v0h3" stroke="currentColor" />
        <path d="M5 18h2a1 1 0 0 1 0 2H5m0 0h2a1 1 0 0 0 0-2H5" stroke="currentColor" />
      </>
    ),
  },
  format_indent_increase: {
    outlined: (
      <>
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="11" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
        <polyline points="14 9 17 12 14 15" />
      </>
    ),
  },
  format_indent_decrease: {
    outlined: (
      <>
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="11" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
        <polyline points="7 9 4 12 7 15" />
      </>
    ),
  },
  format_line_spacing: {
    outlined: (
      <>
        <polyline points="6 5 3 8 6 8" />
        <polyline points="6 19 3 16 6 16" />
        <line x1="3" y1="8" x2="3" y2="16" />
        <line x1="9" y1="6" x2="20" y2="6" />
        <line x1="9" y1="12" x2="20" y2="12" />
        <line x1="9" y1="18" x2="20" y2="18" />
      </>
    ),
  },
  format_paint: {
    outlined: (
      <>
        <rect x="4" y="3" width="16" height="4" rx="1" />
        <path d="M4 7v3h12V7" />
        <rect x="10" y="10" width="4" height="6" rx="1" />
        <path d="M10 16v3a2 2 0 0 0 4 0v-3" />
      </>
    ),
  },
  format_size: {
    outlined: (
      <>
        <path d="M3 16 8 4l5 12" />
        <line x1="5" y1="12" x2="11" y2="12" />
        <path d="M15 18 18 10l3 8" />
        <line x1="16.2" y1="16" x2="19.8" y2="16" />
      </>
    ),
  },
  font_download: {
    outlined: (
      <>
        <path d="m6 18 6-14 6 14" />
        <line x1="8" y1="13" x2="16" y2="13" />
      </>
    ),
  },
  link: {
    outlined: (
      <>
        <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 1 0-7-7l-1 1" />
        <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
      </>
    ),
  },

  // ── format pane ────────────────────────────────────────────────────
  lock: {
    outlined: (
      <>
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </>
    ),
    filled: (
      <>
        <rect x="4" y="11" width="16" height="10" rx="2" fill="currentColor" stroke="none" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </>
    ),
  },
  lock_open: {
    outlined: (
      <>
        <rect x="4" y="11" width="16" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0" />
      </>
    ),
  },
  chevron_double_right: {
    outlined: (
      <>
        <polyline points="7 6 13 12 7 18" />
        <polyline points="13 6 19 12 13 18" />
      </>
    ),
  },
  chevron_down: { outlined: <polyline points="6 9 12 15 18 9" /> },
  chevron_up: { outlined: <polyline points="6 15 12 9 18 15" /> },
  vertical_align_top: {
    outlined: (
      <>
        <line x1="4" y1="3" x2="20" y2="3" />
        <polyline points="8 11 12 7 16 11" />
        <line x1="12" y1="7" x2="12" y2="21" />
      </>
    ),
  },
  vertical_align_center: {
    outlined: (
      <>
        <line x1="4" y1="12" x2="20" y2="12" />
        <polyline points="8 7 12 3 16 7" />
        <polyline points="8 17 12 21 16 17" />
      </>
    ),
  },
  vertical_align_bottom: {
    outlined: (
      <>
        <line x1="4" y1="21" x2="20" y2="21" />
        <polyline points="8 13 12 17 16 13" />
        <line x1="12" y1="3" x2="12" y2="17" />
      </>
    ),
  },
  shadow: {
    outlined: (
      <>
        <rect x="4" y="4" width="13" height="13" rx="1" />
        <path d="M8 17v3h12V8h-3" />
      </>
    ),
  },
  opacity: {
    outlined: <path d="M12 3 6 11a7 7 0 1 0 12 0z" />,
  },
  straighten: {
    outlined: (
      <>
        <rect x="2" y="9" width="20" height="6" rx="1" />
        <line x1="6" y1="9" x2="6" y2="12" />
        <line x1="10" y1="9" x2="10" y2="13" />
        <line x1="14" y1="9" x2="14" y2="13" />
        <line x1="18" y1="9" x2="18" y2="12" />
      </>
    ),
  },

  // ── slideshow / presenter view ─────────────────────────────────────
  pause: {
    outlined: (
      <>
        <rect x="6" y="4" width="4" height="16" rx="1" />
        <rect x="14" y="4" width="4" height="16" rx="1" />
      </>
    ),
    filled: (
      <>
        <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
        <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
      </>
    ),
  },
  present_to_all: {
    outlined: (
      <>
        <rect x="2" y="4" width="20" height="14" rx="1" />
        <polyline points="9 12 12 9 15 12" />
        <line x1="12" y1="9" x2="12" y2="16" />
        <line x1="6" y1="22" x2="18" y2="22" />
      </>
    ),
    filled: (
      <>
        <rect x="2" y="4" width="20" height="14" rx="1" fill="currentColor" stroke="none" />
        <polyline points="9 12 12 9 15 12" stroke="rgba(255,255,255,0.95)" />
        <line x1="12" y1="9" x2="12" y2="16" stroke="rgba(255,255,255,0.95)" />
        <line x1="6" y1="22" x2="18" y2="22" />
      </>
    ),
  },
  timer: {
    outlined: (
      <>
        <circle cx="12" cy="13" r="8" />
        <polyline points="12 9 12 13 15 15" />
        <line x1="9" y1="3" x2="15" y2="3" />
      </>
    ),
  },
  note: {
    outlined: (
      <>
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
        <polyline points="14 3 14 9 20 9" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="14" y2="17" />
      </>
    ),
  },
  next_plan: {
    outlined: (
      <>
        <circle cx="12" cy="12" r="9" />
        <polyline points="10 8 14 12 10 16" />
      </>
    ),
  },
  keyboard_double_arrow_right: {
    outlined: (
      <>
        <polyline points="7 6 13 12 7 18" />
        <polyline points="13 6 19 12 13 18" />
      </>
    ),
  },

  // ── find &amp; replace ────────────────────────────────────────────────
  find_replace: {
    outlined: (
      <>
        <circle cx="9" cy="9" r="5" />
        <line x1="13" y1="13" x2="17" y2="17" />
        <polyline points="14 19 17 22 20 19" />
        <path d="M17 22V14" />
      </>
    ),
  },
  match_case: {
    outlined: (
      <>
        <path d="M3 18 7 6l4 12" />
        <line x1="4.5" y1="14" x2="9.5" y2="14" />
        <circle cx="16.5" cy="15" r="3.2" />
        <line x1="19.7" y1="12" x2="19.7" y2="18" />
      </>
    ),
    filled: (
      <>
        <path d="M3 18 7 6l4 12" stroke="currentColor" />
        <rect x="4.5" y="13" width="5" height="2" fill="currentColor" stroke="none" />
        <circle cx="16.5" cy="15" r="3.2" fill="currentColor" stroke="none" />
        <rect x="18.7" y="12" width="2" height="6" fill="currentColor" stroke="none" />
      </>
    ),
  },
  regex: {
    outlined: (
      <>
        <line x1="12" y1="4" x2="12" y2="14" />
        <line x1="7.6" y1="6.5" x2="16.4" y2="11.5" />
        <line x1="16.4" y1="6.5" x2="7.6" y2="11.5" />
        <circle cx="6.5" cy="18" r="1.4" fill="currentColor" stroke="none" />
      </>
    ),
    filled: (
      <>
        <line x1="12" y1="4" x2="12" y2="14" stroke="currentColor" />
        <line x1="7.6" y1="6.5" x2="16.4" y2="11.5" stroke="currentColor" />
        <line x1="16.4" y1="6.5" x2="7.6" y2="11.5" stroke="currentColor" />
        <circle cx="6.5" cy="18" r="1.8" fill="currentColor" stroke="none" />
      </>
    ),
  },
  text_format: {
    outlined: (
      <>
        <polyline points="3 6 11 6 7 6 7 16" />
        <polyline points="13 9 19 9 16 9 16 16" />
        <line x1="3" y1="20" x2="19" y2="20" />
      </>
    ),
    filled: (
      <>
        <polyline points="3 6 11 6 7 6 7 16" stroke="currentColor" />
        <polyline points="13 9 19 9 16 9 16 16" stroke="currentColor" />
        <rect x="3" y="19" width="16" height="2" fill="currentColor" stroke="none" />
      </>
    ),
  },

  // ── picker upgrades ────────────────────────────────────────────────
  format_color_reset: {
    outlined: (
      <>
        <path d="M7 4 4 7l8 8 8-8-3-3-5 5-5-5z" />
        <path d="M5 18a3 3 0 0 0 6 0c0-2-3-5-3-5s-3 3-3 5z" />
        <line x1="3" y1="3" x2="21" y2="21" />
      </>
    ),
  },
  gradient: {
    outlined: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="3" y1="9" x2="21" y2="9" opacity="0.7" />
        <line x1="3" y1="13" x2="21" y2="13" opacity="0.4" />
        <line x1="3" y1="17" x2="21" y2="17" opacity="0.2" />
      </>
    ),
  },
};

// Render-time map from the (deprecated) Material Symbols name space we used
// pre-Wave 2 to canonical Lucide-style names. Kept short — only entries that
// are still referenced in the codebase. Adding a new alias here is cheaper
// than renaming every call site.
const ALIASES: Record<string, string> = {
  shapes: 'category',
  // Find dialog uses the same magnifier as the shortcuts search.
  find_in_page: 'search',
  // PowerPoint/Material name for the "expand more" caret.
  arrow_drop_down: 'expand_more',
};

function isPair(
  v: IconBody,
): v is { outlined: JSX.Element; filled?: JSX.Element } {
  return typeof v === 'object' && v !== null && 'outlined' in (v as object);
}

function bodyFor(name: string, filled: boolean): JSX.Element | null {
  const key = ALIASES[name] ?? name;
  const entry = ICONS[key];
  if (!entry) return null;
  if (isPair(entry)) {
    return filled ? (entry.filled ?? entry.outlined) : entry.outlined;
  }
  return entry;
}

const WARNED: Set<string> = new Set();

export function Icon({ name, size = 18, filled = false, className }: IconProps) {
  // Dev warn ONCE per missing name so the gap is obvious in the console
  // without flooding it on every render.
  const warnedRef = useRef(false);
  useEffect(() => {
    const key = ALIASES[name] ?? name;
    if (!ICONS[key] && !WARNED.has(key) && !warnedRef.current) {
      WARNED.add(key);
      warnedRef.current = true;
      // eslint-disable-next-line no-console
      console.warn(`[Icon] missing SVG for name "${key}". Add it to apps/web/src/shell/icons.tsx.`);
    }
  }, [name]);

  const body = bodyFor(name, filled);
  if (!body) {
    // Neutral placeholder — never raw text. 16×16 outlined square.
    return (
      <svg
        className={`cs-icon cs-icon--missing ${className ?? ''}`}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden="true"
        focusable="false"
        data-icon-missing={name}
      >
        <rect x="4" y="4" width="16" height="16" rx="2" />
      </svg>
    );
  }
  return (
    <svg
      className={`cs-icon ${filled ? 'cs-icon--filled' : ''} ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {body}
    </svg>
  );
}
