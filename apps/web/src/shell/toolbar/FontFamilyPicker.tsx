// Font-family picker — Google Slides-style "Font" combobox dropdown.
//
// Source list mirrors the deck-fonts pack loaded by `index.html`
// (lines 146 + 154). When a user picks a font, we dispatch
// `doc.command.set-inline-format-font-family` with `{ value: '<name>' }`;
// Univer's docs-ui inline-format pipeline rewrites every selected text
// run's `ff`. If no text selection is active inside an editable doc, the
// command no-ops gracefully (Univer-side guard).
import { useMemo, useRef, useState } from 'react';
import { dispatchSlideCommand } from '../../univer/commands';
import { Icon } from '../icons';
import { useTranslation } from '../../i18n';
import { anchorPosition, useDismiss } from './popover-utils';

// Buckets correspond to the families pre-loaded by index.html. Keeping each
// item as { name, style } lets us render each row in its own face — same as
// Google Slides does — without paying extra @font-face round-trips.
interface FontEntry {
  name: string;
  // CSS font-family string. For metric-compat MS replacements we still show
  // the MS label so users searching for "Calibri" find Carlito.
  family?: string;
}

interface FontSection {
  labelKey: string;
  fonts: FontEntry[];
}

const SECTIONS: FontSection[] = [
  {
    labelKey: 'toolbar.font.sectionPopular',
    fonts: [
      { name: 'Inter' },
      { name: 'Roboto' },
      { name: 'Arial' },
      { name: 'Helvetica' },
      { name: 'Calibri', family: 'Carlito, Calibri, sans-serif' },
      { name: 'Cambria', family: 'Caladea, Cambria, serif' },
      { name: 'Times New Roman' },
      { name: 'Georgia' },
      { name: 'Verdana' },
    ],
  },
  {
    labelKey: 'toolbar.font.sectionSans',
    fonts: [
      { name: 'Open Sans' },
      { name: 'Lato' },
      { name: 'Source Sans 3' },
      { name: 'Montserrat' },
      { name: 'Noto Sans' },
      { name: 'PT Sans' },
      { name: 'Raleway' },
      { name: 'Poppins' },
      { name: 'Nunito' },
      { name: 'Nunito Sans' },
      { name: 'Work Sans' },
      { name: 'Rubik' },
      { name: 'Mulish' },
      { name: 'DM Sans' },
      { name: 'Fira Sans' },
      { name: 'Manrope' },
      { name: 'Karla' },
      { name: 'Cabin' },
      { name: 'Josefin Sans' },
      { name: 'Archivo' },
      { name: 'Barlow' },
      { name: 'Heebo' },
      { name: 'Hind' },
      { name: 'Quicksand' },
      { name: 'Oswald' },
      { name: 'Bebas Neue' },
      { name: 'Anton' },
    ],
  },
  {
    labelKey: 'toolbar.font.sectionSerif',
    fonts: [
      { name: 'Merriweather' },
      { name: 'Playfair Display' },
      { name: 'Roboto Slab' },
      { name: 'Noto Serif' },
      { name: 'PT Serif' },
      { name: 'Crimson Text' },
      { name: 'Libre Baskerville' },
      { name: 'Cormorant Garamond' },
      { name: 'DM Serif Display' },
      { name: 'EB Garamond' },
      { name: 'Bitter' },
    ],
  },
  {
    labelKey: 'toolbar.font.sectionMono',
    fonts: [
      { name: 'Roboto Mono' },
      { name: 'Inconsolata' },
    ],
  },
];

const ALL_FONTS: FontEntry[] = SECTIONS.flatMap((s) => s.fonts);

export interface FontFamilyPickerProps {
  // Current font (best-effort from selection or last applied). Used to mark
  // the active entry and as the trigger label.
  value: string;
  onChange: (font: string) => void;
}

export function FontFamilyPicker({ value, onChange }: FontFamilyPickerProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [filter, setFilter] = useState('');

  useDismiss(!!anchor, popoverRef, () => setAnchor(null));

  const filtered = useMemo(() => {
    if (!filter.trim()) return SECTIONS;
    const q = filter.toLowerCase();
    const hits = ALL_FONTS.filter((f) => f.name.toLowerCase().includes(q));
    return hits.length
      ? [{ labelKey: 'toolbar.font.sectionPopular', fonts: hits }]
      : [];
  }, [filter]);

  function pick(font: FontEntry) {
    onChange(font.name);
    // Univer's set-font-family takes `{ value: string }`.
    void dispatchSlideCommand('doc.command.set-inline-format-font-family', {
      value: font.family ?? font.name,
    });
    setAnchor(null);
    setFilter('');
  }

  const pos = anchorPosition(anchor, 280, 420);

  return (
    <div className="cs-toolbar2__combo cs-toolbar2__combo--font">
      <button
        ref={triggerRef}
        type="button"
        className="cs-toolbar2__combo-trigger"
        title={t('toolbar.fontFamilyAria')}
        aria-label={t('toolbar.fontFamilyAria')}
        aria-haspopup="listbox"
        aria-expanded={!!anchor}
        onClick={() => setAnchor(anchor ? null : triggerRef.current!.getBoundingClientRect())}
      >
        <span className="cs-toolbar2__combo-value" style={{ fontFamily: value }}>
          {value}
        </span>
        <Icon name="expand_more" size={14} className="cs-toolbar2__caret" />
      </button>
      {pos && (
        <div
          ref={popoverRef}
          className="cs-toolbar2__popover cs-toolbar2__popover--fonts"
          role="dialog"
          aria-label={t('toolbar.fontFamily')}
          style={{ top: pos.top, left: pos.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="cs-toolbar2__popover-search">
            <input
              type="text"
              value={filter}
              placeholder={t('toolbar.fontFamily')}
              onChange={(e) => setFilter(e.target.value)}
              className="cs-toolbar2__popover-search-input"
              autoFocus
              aria-label={t('toolbar.fontFamily')}
            />
          </div>
          <div className="cs-toolbar2__popover-scroll" role="listbox">
            {filtered.map((section) => (
              <div key={section.labelKey} className="cs-toolbar2__popover-section">
                <div className="cs-toolbar2__popover-section-label">{t(section.labelKey)}</div>
                {section.fonts.map((font) => {
                  const isActive = font.name.toLowerCase() === value.toLowerCase();
                  return (
                    <button
                      key={font.name}
                      type="button"
                      className={`cs-toolbar2__popover-item ${isActive ? 'is-active' : ''}`}
                      role="option"
                      aria-selected={isActive}
                      onClick={() => pick(font)}
                      style={{ fontFamily: font.family ?? font.name }}
                    >
                      {isActive && <Icon name="check" size={14} className="cs-toolbar2__check" />}
                      <span>{font.name}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
