// Reusable colour picker — Google Slides shape. 16-chip theme palette,
// "Recent colors" row (persisted in localStorage), custom HEX field, and an
// optional "No fill" / "Reset" row for the fill/outline variant.
//
// Caller hands us an `onPick(rgb)` to apply + an optional `onClear()` for
// the "No fill" row. The component owns its own dropdown anchor — the host
// just renders a `<ColorPickerSplitButton …>` next to its sibling.
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { useTranslation } from '../../i18n';
import { anchorPosition, hexToRgb, rgbToHex, useDismiss } from './popover-utils';

// Same 16-chip swatch BackgroundPicker uses, so a slide-author building a
// palette sees identical colour primitives for background and for text/fill.
const PALETTE: { key: string; rgb: string }[] = [
  { key: 'white',     rgb: 'rgb(255, 255, 255)' },
  { key: 'lightGray', rgb: 'rgb(243, 244, 246)' },
  { key: 'gray',      rgb: 'rgb(156, 163, 175)' },
  { key: 'darkGray',  rgb: 'rgb(75, 85, 99)' },
  { key: 'nearBlack', rgb: 'rgb(34, 38, 45)' },
  { key: 'cream',     rgb: 'rgb(250, 248, 244)' },
  { key: 'sky',       rgb: 'rgb(230, 244, 255)' },
  { key: 'mint',      rgb: 'rgb(230, 250, 240)' },
  { key: 'red',       rgb: 'rgb(220, 38, 38)' },
  { key: 'orange',    rgb: 'rgb(234, 88, 12)' },
  { key: 'yellow',    rgb: 'rgb(234, 179, 8)' },
  { key: 'green',     rgb: 'rgb(22, 163, 74)' },
  { key: 'blue',      rgb: 'rgb(37, 99, 235)' },
  { key: 'indigo',    rgb: 'rgb(79, 70, 229)' },
  { key: 'purple',    rgb: 'rgb(124, 58, 237)' },
  { key: 'pink',      rgb: 'rgb(219, 39, 119)' },
];

const RECENT_MAX = 8;

function recentKey(scope: string): string {
  return `cs.toolbar.recentColors.${scope}`;
}

function readRecent(scope: string): string[] {
  try {
    const raw = localStorage.getItem(recentKey(scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string').slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function writeRecent(scope: string, rgb: string): string[] {
  try {
    const prev = readRecent(scope).filter((c) => c !== rgb);
    const next = [rgb, ...prev].slice(0, RECENT_MAX);
    localStorage.setItem(recentKey(scope), JSON.stringify(next));
    return next;
  } catch {
    return readRecent(scope);
  }
}

export type ColorPickerScope = 'text' | 'fill' | 'border';

export interface ColorPickerProps {
  // 'text' | 'fill' | 'border' — selects the icon, default chip, recent-color
  // localStorage bucket, and whether the "No fill" row appears.
  scope: ColorPickerScope;
  // Last applied colour, used to paint the split-button preview.
  value: string | null;
  onPick: (rgb: string) => void;
  // For fill/border only — "No fill" picks transparent.
  onClear?: () => void;
  icon: string;
  label: string;
  // Optional shortcut hint (Ctrl+…); we add it to the trigger's title.
  shortcut?: string;
}

export function ColorPicker({ scope, value, onPick, onClear, icon, label, shortcut }: ColorPickerProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [recent, setRecent] = useState<string[]>(() => readRecent(scope));
  const [hex, setHex] = useState(() => rgbToHex(value));

  useDismiss(!!anchor, popoverRef, () => setAnchor(null));

  useEffect(() => {
    setHex(rgbToHex(value));
  }, [value]);

  function apply(rgb: string) {
    onPick(rgb);
    setRecent(writeRecent(scope, rgb));
    setAnchor(null);
  }

  function applyCustom() {
    const rgb = hexToRgb(hex);
    if (rgb) apply(rgb);
  }

  const title = shortcut ? `${label} (${shortcut})` : label;
  // Preview swatch under the icon — the "current colour" indicator that
  // makes the split-button a one-click apply path for the last-used colour.
  const previewColor = value ?? (scope === 'text' ? 'rgb(34, 38, 45)' : null);

  const pos = anchorPosition(anchor, 248, 320);

  return (
    <div className="cs-toolbar2__color">
      <button
        type="button"
        className="cs-toolbar2__color-apply"
        title={title}
        aria-label={label}
        onClick={() => previewColor && apply(previewColor)}
        disabled={!previewColor}
      >
        <Icon name={icon} size={16} />
        <span
          className="cs-toolbar2__color-bar"
          aria-hidden="true"
          style={{ background: previewColor ?? 'transparent' }}
        />
      </button>
      <button
        ref={triggerRef}
        type="button"
        className="cs-toolbar2__color-caret"
        title={label}
        aria-label={`${label} ▾`}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={() => setAnchor(anchor ? null : triggerRef.current!.getBoundingClientRect())}
      >
        <Icon name="expand_more" size={12} />
      </button>
      {pos && (
        <div
          ref={popoverRef}
          className="cs-toolbar2__popover cs-toolbar2__popover--color"
          role="dialog"
          aria-label={label}
          style={{ top: pos.top, left: pos.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="cs-toolbar2__popover-section-label">
            {t('toolbar:color.themeColors')}
          </div>
          <div className="cs-toolbar2__color-grid">
            {PALETTE.map((chip) => (
              <button
                key={chip.rgb}
                type="button"
                className="cs-toolbar2__color-chip"
                style={{ background: chip.rgb }}
                title={t(`toolbar.color.${chip.key}`)}
                aria-label={t(`toolbar.color.${chip.key}`)}
                onClick={() => apply(chip.rgb)}
              />
            ))}
          </div>
          {recent.length > 0 && (
            <>
              <div className="cs-toolbar2__popover-section-label">
                {t('toolbar:color.recent')}
              </div>
              <div className="cs-toolbar2__color-grid">
                {recent.map((rgb) => (
                  <button
                    key={rgb}
                    type="button"
                    className="cs-toolbar2__color-chip"
                    style={{ background: rgb }}
                    title={rgb}
                    aria-label={rgb}
                    onClick={() => apply(rgb)}
                  />
                ))}
              </div>
            </>
          )}
          <div className="cs-toolbar2__color-custom">
            <label className="cs-toolbar2__color-custom-label">
              <input
                type="color"
                value={hex}
                onChange={(e) => setHex(e.target.value)}
                className="cs-toolbar2__color-custom-input"
                aria-label={t('toolbar:color.custom')}
              />
              <span>{t('toolbar:color.custom')}</span>
            </label>
            <input
              type="text"
              value={hex}
              onChange={(e) => setHex(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyCustom();
              }}
              className="cs-toolbar2__color-hex"
              aria-label={t('toolbar:color.hexLabel')}
              spellCheck={false}
            />
            <button
              type="button"
              className="cs-btn cs-btn--primary cs-toolbar2__color-apply-btn"
              onClick={applyCustom}
            >
              {t('toolbar:color.apply')}
            </button>
          </div>
          {onClear && (
            <button
              type="button"
              className="cs-toolbar2__popover-item cs-toolbar2__color-clear"
              onClick={() => {
                onClear();
                setAnchor(null);
              }}
            >
              <Icon name="close" size={14} />
              <span>{t('toolbar:color.noFill')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
