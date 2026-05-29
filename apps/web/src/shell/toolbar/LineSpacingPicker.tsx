// Line-spacing popover — preset rows (1.0 / 1.15 / 1.5 / 2.0 / 2.5 / 3.0).
//
// Wired to `doc-paragraph-setting.command` (docs-ui v0.24.0) via the
// `setLineSpacing` helper: each preset writes the paragraph's `lineSpacing`
// multiplier with `SpacingRule.AUTO`, the same call the built-in docs-ui
// paragraph-setting panel makes. Functional on any text frame the caret is
// inside.
import { useRef, useState } from 'react';
import { Icon } from '../icons';
import { useTranslation } from '../../i18n';
import { setLineSpacing } from '../../univer/commands';
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
                    void setLineSpacing(preset.value);
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
