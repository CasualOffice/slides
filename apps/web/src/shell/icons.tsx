// Material Symbols Outlined font is loaded via index.html. We use the
// font glyphs inside <Icon> components instead of inline SVGs because:
//   1. The font is already on every device that loaded the index, so no
//      extra HTTP round-trips per icon.
//   2. Sizing is consistent via font-variation-settings.
//   3. The same icon ids align with Google's Material Symbols search ui
//      (https://fonts.google.com/icons).
//
// `Icon` renders a <span> with the Material Symbols class and the icon
// name as text content. The pre-loaded font replaces the glyph at paint
// time. No emoji, no inline SVG strings, no per-icon imports.

export interface IconProps {
  name: string;
  size?: number;
  filled?: boolean;
  className?: string;
}

export function Icon({ name, size = 18, filled = false, className }: IconProps) {
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
