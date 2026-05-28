// Line-spacing popover — preset rows (1.0 / 1.15 / 1.5 / 2.0 / 2.5 / 3.0) +
// a "Custom spacing…" row.
//
// TODO(univer): docs-ui v0.24.0 exposes NO line-spacing command — the only
// paragraph-level mutation surface is alignment + lists. Implementing this
// upstream means a new `doc.command.set-line-spacing` that rewrites the
// paragraph's `spaceBefore` / `spaceAfter` / `lineHeight` fields via the
// same RichTextEditingMutation path the align/list commands use. Tracked in
// `docs/UNIVER_SLIDES_GAPS.md`. Until the fork lands, the preset buttons
// remain inert — they update local state so the popover highlights the
// chosen value, but no mutation broadcasts.
import { useRef, useState } from 'react';
import { Icon } from '../icons';
import { useTranslation } from '../../i18n';
import { anchorPosition, useDismiss } from './popover-utils';

const PRESETS: { value: number; labelKey: string }[] = [
  { value: 1.0,  labelKey: 'toolbar:spacing.single' },
  { value: 1.15, labelKey: 'toolbar:spacing.preset1_15' },
  { value: 1.5,  labelKey: 'toolbar:spacing.preset1_5' },
  { value: 2.0,  labelKey: 'toolbar:spacing.double' },
  { value: 2.5,  labelKey: 'toolbar:spacing.preset2_5' },
  { value: 3.0,  labelKey: 'toolbar:spacing.preset3' },
];

export interface LineSpacingPickerProps {
  value: number;
  onChange: (value: number) => void;
}

export function LineSpacingPicker({ value, onChange }: LineSpacingPickerProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  useDismiss(!!anchor, popoverRef, () => setAnchor(null));

  const pos = anchorPosition(anchor, 200, 240);

  return (
    <div className="cs-toolbar2__split">
      <button
        ref={triggerRef}
        type="button"
        className="cs-toolbar2__btn cs-toolbar2__btn--with-caret"
        title={t('toolbar:lineSpacing')}
        aria-label={t('toolbar:lineSpacing')}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={() => setAnchor(anchor ? null : triggerRef.current!.getBoundingClientRect())}
      >
        <Icon name="format_line_spacing" size={16} />
        <Icon name="expand_more" size={12} className="cs-toolbar2__caret" />
      </button>
      {pos && (
        <div
          ref={popoverRef}
          className="cs-toolbar2__popover cs-toolbar2__popover--spacing"
          role="dialog"
          aria-label={t('toolbar:lineSpacing')}
          style={{ top: pos.top, left: pos.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="cs-toolbar2__popover-scroll" role="listbox">
            {PRESETS.map((preset) => {
              const isActive = Math.abs(preset.value - value) < 0.001;
              return (
                <button
                  key={preset.value}
                  type="button"
                  className={`cs-toolbar2__popover-item ${isActive ? 'is-active' : ''}`}
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    onChange(preset.value);
                    setAnchor(null);
                    // TODO(univer): dispatch 'doc.command.set-line-spacing' once
                    // the upstream command lands. Inert until then.
                  }}
                >
                  {isActive && <Icon name="check" size={12} className="cs-toolbar2__check" />}
                  <span>{t(preset.labelKey)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
