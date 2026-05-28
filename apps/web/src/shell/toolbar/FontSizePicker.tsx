// Font-size combobox — `-` stepper · numeric input · `+` stepper · dropdown
// of common sizes (Google Slides preset list).
//
// Dispatches `doc.command.set-inline-format-fontsize` with `{ value: number }`
// on each commit (Enter / blur / preset click / stepper press).
import { useEffect, useRef, useState } from 'react';
import { dispatchSlideCommand } from '../../univer/commands';
import { Icon } from '../icons';
import { useTranslation } from '../../i18n';
import { anchorPosition, useDismiss } from './popover-utils';

const PRESETS = [8, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96] as const;
const MIN = 1;
const MAX = 400;

export interface FontSizePickerProps {
  value: number;
  onChange: (size: number) => void;
}

function commit(size: number, onChange: (n: number) => void): void {
  const clamped = Math.max(MIN, Math.min(MAX, Math.round(size)));
  onChange(clamped);
  void dispatchSlideCommand('doc.command.set-inline-format-fontsize', {
    value: clamped,
  });
}

export function FontSizePicker({ value, onChange }: FontSizePickerProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [draft, setDraft] = useState(String(value));

  useDismiss(!!anchor, popoverRef, () => setAnchor(null));

  // Reflect external value changes (e.g. selection moved into a 36-pt run)
  // unless the user is actively editing the input.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(String(value));
  }, [value]);

  const pos = anchorPosition(anchor, 80, 280);

  return (
    <div className="cs-toolbar2__combo cs-toolbar2__combo--size">
      <button
        type="button"
        className="cs-toolbar2__step"
        onClick={() => commit(value - 1, onChange)}
        title={t('toolbar:fontSizeDecrease')}
        aria-label={t('toolbar:fontSizeDecrease')}
      >
        <Icon name="remove" size={14} />
      </button>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        className="cs-toolbar2__size-input"
        value={draft}
        aria-label={t('toolbar:fontSize')}
        onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ''))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const n = parseInt(draft, 10);
            if (!Number.isNaN(n)) commit(n, onChange);
            inputRef.current?.blur();
          }
          if (e.key === 'Escape') {
            setDraft(String(value));
            inputRef.current?.blur();
          }
        }}
        onBlur={() => {
          const n = parseInt(draft, 10);
          if (!Number.isNaN(n) && n !== value) commit(n, onChange);
          else setDraft(String(value));
        }}
      />
      <button
        type="button"
        className="cs-toolbar2__step"
        onClick={() => commit(value + 1, onChange)}
        title={t('toolbar:fontSizeIncrease')}
        aria-label={t('toolbar:fontSizeIncrease')}
      >
        <Icon name="add" size={14} />
      </button>
      <button
        ref={triggerRef}
        type="button"
        className="cs-toolbar2__combo-caret"
        title={t('toolbar:fontSize')}
        aria-label={t('toolbar:fontSize')}
        aria-haspopup="listbox"
        aria-expanded={!!anchor}
        onClick={() => setAnchor(anchor ? null : triggerRef.current!.getBoundingClientRect())}
      >
        <Icon name="expand_more" size={12} />
      </button>
      {pos && (
        <div
          ref={popoverRef}
          className="cs-toolbar2__popover cs-toolbar2__popover--sizes"
          role="dialog"
          aria-label={t('toolbar:fontSize')}
          style={{ top: pos.top, left: pos.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="cs-toolbar2__popover-scroll" role="listbox">
            {PRESETS.map((size) => {
              const isActive = size === value;
              return (
                <button
                  key={size}
                  type="button"
                  className={`cs-toolbar2__popover-item ${isActive ? 'is-active' : ''}`}
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    commit(size, onChange);
                    setAnchor(null);
                  }}
                >
                  {isActive && <Icon name="check" size={12} className="cs-toolbar2__check" />}
                  <span>{size}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
