// Shared hooks for the v2 toolbar popovers. Centralised so every picker
// closes the same way (Escape + outside mousedown) and computes its on-screen
// position with the same right-edge clamp.
import { useEffect } from 'react';

export interface PositionedRect {
  top: number;
  left: number;
}

// Anchor-below positioning with right-edge + bottom-edge clamping. The popover
// sits 6 px under the anchor; if it would overflow off the viewport we pull it
// back. We deliberately keep the simple `position: fixed` strategy used by
// BackgroundPicker so the popover follows the toolbar through window resize.
export function anchorPosition(
  anchor: DOMRect | null,
  popoverWidth: number,
  popoverHeight = 320,
): PositionedRect | null {
  if (!anchor) return null;
  const margin = 8;
  const left = Math.min(anchor.left, window.innerWidth - popoverWidth - margin);
  const topBelow = anchor.bottom + 6;
  // If a tall popover would clip the viewport bottom, flip above the anchor.
  const top = topBelow + popoverHeight + margin > window.innerHeight
    ? Math.max(margin, anchor.top - popoverHeight - 6)
    : topBelow;
  return { top, left: Math.max(margin, left) };
}

// Bind Escape + outside-click to close the popover. Pass null `containerRef`
// to disable. We listen on `mousedown` instead of `click` so dragging from
// inside-out doesn't unmount mid-interaction.
export function useDismiss(
  open: boolean,
  containerRef: React.RefObject<HTMLElement>,
  onClose: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, containerRef, onClose]);
}

// "#rrggbb" → "rgb(r,g,b)" — same normalisation as BackgroundPicker so the
// model only sees one shape. Returns null on invalid input.
export function hexToRgb(hex: string): string | null {
  let s = hex.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

export function rgbToHex(rgb: string | null | undefined): string {
  if (!rgb) return '#000000';
  const m = rgb.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (!m) {
    // Already a hex? Pad short form.
    if (/^#?[0-9a-fA-F]{3}$/.test(rgb)) return `#${rgb.replace('#', '').split('').map((c) => c + c).join('')}`;
    if (/^#?[0-9a-fA-F]{6}$/.test(rgb)) return rgb.startsWith('#') ? rgb : `#${rgb}`;
    return '#000000';
  }
  const toHex = (n: string) =>
    Math.max(0, Math.min(255, parseInt(n, 10))).toString(16).padStart(2, '0');
  return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`.toUpperCase();
}
