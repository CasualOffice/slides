// Icon component.
//
// The legacy implementation (kept as the fallback path below) uses Material
// Symbols Outlined as a font — `<span>name</span>` and the loaded font swaps
// the glyph. Cheap, no per-icon imports, but the glyphs only render after
// the font finishes loading (FOIT for the first ~50–200 ms on cold cache)
// and the spans expose the raw glyph name to screen readers + a11y trees
// before the font swap.
//
// Toolbar v2 ships its own SVG paths via the `ICONS` map below (Lucide
// outline geometry, MIT). Names listed here render synchronously as inline
// SVG with the requested pixel size; unknown names fall through to the
// Material Symbols font path so the rest of the shell (TitleBar, dialogs,
// SlideContextMenu, …) keeps rendering exactly as before. This dual mode
// lets the v2 work land without a stylesheet rewrite of every consumer.
//
// New icon entries should mirror Lucide's 24-grid stroke=2 path data — the
// `viewBox` is hard-coded to 0 0 24 24 below so each entry is just the
// inner SVG.

export interface IconProps {
  name: string;
  size?: number;
  filled?: boolean;
  className?: string;
}

// Inline SVG bodies. Each value renders inside an <svg viewBox="0 0 24 24"
// fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
// stroke-linejoin="round">. Lucide-style geometry; same visual weight as the
// Material Symbols outlined family the rest of the shell uses so the two
// paths can coexist without looking mismatched.
const ICONS: Record<string, JSX.Element> = {
  // ── formatting toggles ─────────────────────────────────────────────
  bold: (
    <>
      <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
      <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z" />
    </>
  ),
  italic: (
    <>
      <line x1="19" y1="4" x2="10" y2="4" />
      <line x1="14" y1="20" x2="5" y2="20" />
      <line x1="15" y1="4" x2="9" y2="20" />
    </>
  ),
  underline: (
    <>
      <path d="M6 4v6a6 6 0 0 0 12 0V4" />
      <line x1="4" y1="20" x2="20" y2="20" />
    </>
  ),
  strikethrough: (
    <>
      <path d="M16 4H9a3 3 0 0 0-2.83 4" />
      <path d="M14 12a4 4 0 0 1 0 8H6" />
      <line x1="4" y1="12" x2="20" y2="12" />
    </>
  ),
  format_clear: (
    <>
      <path d="M4 7h6m4 0h6" />
      <path d="M10 4v4l-4 12" />
      <path d="m14 4-2 6" />
      <line x1="4" y1="20" x2="20" y2="20" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </>
  ),

  // ── paragraph alignment ───────────────────────────────────────────
  format_align_left: (
    <>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="15" y2="12" />
      <line x1="3" y1="18" x2="18" y2="18" />
    </>
  ),
  format_align_center: (
    <>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="6" y1="12" x2="18" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </>
  ),
  format_align_right: (
    <>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="9" y1="12" x2="21" y2="12" />
      <line x1="6" y1="18" x2="21" y2="18" />
    </>
  ),
  format_align_justify: (
    <>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </>
  ),

  // ── lists & indent ────────────────────────────────────────────────
  format_list_bulleted: (
    <>
      <line x1="9" y1="6" x2="20" y2="6" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="9" y1="18" x2="20" y2="18" />
      <circle cx="4.5" cy="6" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="18" r="1.25" fill="currentColor" stroke="none" />
    </>
  ),
  format_list_numbered: (
    <>
      <line x1="10" y1="6" x2="21" y2="6" />
      <line x1="10" y1="12" x2="21" y2="12" />
      <line x1="10" y1="18" x2="21" y2="18" />
      <path d="M4 4h2v4" />
      <path d="M4 10h2.5a1.5 1.5 0 0 1 0 3H4v1h3" />
      <path d="M4 17h2a1.5 1.5 0 0 1 0 3H4" />
    </>
  ),
  format_indent_increase: (
    <>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
      <line x1="11" y1="12" x2="21" y2="12" />
      <path d="m3 9 4 3-4 3z" fill="currentColor" stroke="none" />
    </>
  ),
  format_indent_decrease: (
    <>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
      <line x1="11" y1="12" x2="21" y2="12" />
      <path d="m7 9-4 3 4 3z" fill="currentColor" stroke="none" />
    </>
  ),
  format_line_spacing: (
    <>
      <path d="m4 6 2-2 2 2" />
      <path d="m4 18 2 2 2-2" />
      <line x1="6" y1="4" x2="6" y2="20" />
      <line x1="12" y1="6" x2="21" y2="6" />
      <line x1="12" y1="12" x2="21" y2="12" />
      <line x1="12" y1="18" x2="21" y2="18" />
    </>
  ),

  // ── colors / paint / link / more ─────────────────────────────────
  format_paint: (
    <>
      <path d="M19 5V3H5v4h14V5z" />
      <path d="M5 9v6h8v3a2 2 0 0 0 4 0v-3a4 4 0 0 0-4-4z" />
    </>
  ),
  format_color_text: (
    <>
      <path d="m6 18 6-14 6 14" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="4" y1="21" x2="20" y2="21" />
    </>
  ),
  format_color_fill: (
    <>
      <path d="M19 11 8 22 3 17 14 6z" />
      <path d="m5 2 5 5" />
      <path d="M2 22h20" />
    </>
  ),
  border_color: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07L11 5" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07L13 19" />
    </>
  ),
  more_vert: (
    <>
      <circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),

  // ── font helpers used by the pickers ────────────────────────────
  format_size: (
    <>
      <path d="M4 6h10" />
      <path d="M9 6v14" />
      <path d="M14 12h6" />
      <path d="M17 12v8" />
    </>
  ),
  font_download: (
    <>
      <path d="M5 5h14v14H5z" />
      <path d="M8 16 12 6l4 10" />
      <line x1="9.5" y1="13" x2="14.5" y2="13" />
    </>
  ),

  // ── shared utilities the v2 toolbar needs as SVG too ──────────────
  expand_more: (
    <>
      <polyline points="6 9 12 15 18 9" />
    </>
  ),
  check: (
    <>
      <polyline points="20 6 9 17 4 12" />
    </>
  ),
  close: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
  add: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  remove: (
    <>
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
};

export function Icon({ name, size = 18, filled = false, className }: IconProps) {
  const svgBody = ICONS[name];
  if (svgBody) {
    return (
      <svg
        className={`cs-icon ${className ?? ''}`}
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
        {svgBody}
      </svg>
    );
  }
  // Legacy Material Symbols glyph path — preserved so existing call sites
  // (TitleBar, SlideContextMenu, dialogs, status bar) keep rendering until
  // each one is migrated to its own SVG entry.
  return (
    <span
      className={`cs-icon material-symbols-outlined ${className ?? ''}`}
      style={{
        fontSize: size,
        fontVariationSettings: `'FILL' ${filled ? 1 : 0}, 'wght' 400, 'opsz' 24`,
      }}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}
