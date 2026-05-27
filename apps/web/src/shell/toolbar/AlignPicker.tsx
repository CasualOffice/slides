// Horizontal-align picker — popover with the 4-way segmented control
// (left · center · right · justify). Dispatches `doc.command.align-*`.
//
// Vertical align is intentionally OMITTED for now: Univer's docs-ui has no
// `set-vertical-align` paragraph command in v0.24.0. Slide-side text-frame
// vertical alignment lives on the shape itself (`anchor`) and would need a
// dedicated `slide.mutation.update-element` patch — TODO(univer) below.
import { useRef, useState } from 'react';
import { dispatchSlideCommand } from '../../univer/commands';
import { Icon } from '../icons';
import { useTranslation } from '../../i18n';
import { anchorPosition, useDismiss } from './popover-utils';

export type AlignValue = 'left' | 'center' | 'right' | 'justify';

interface AlignEntry {
  value: AlignValue;
  icon: string;
  labelKey: string;
  cmd: string;
}

const ALIGNS: AlignEntry[] = [
  { value: 'left',    icon: 'format_align_left',    labelKey: 'toolbar.alignLeft',    cmd: 'doc.command.align-left' },
  { value: 'center',  icon: 'format_align_center',  labelKey: 'toolbar.alignCenter',  cmd: 'doc.command.align-center' },
  { value: 'right',   icon: 'format_align_right',   labelKey: 'toolbar.alignRight',   cmd: 'doc.command.align-right' },
  { value: 'justify', icon: 'format_align_justify', labelKey: 'toolbar.alignJustify', cmd: 'doc.command.align-justify' },
];

export interface AlignPickerProps {
  value: AlignValue;
  onChange: (value: AlignValue) => void;
}

export function AlignPicker({ value, onChange }: AlignPickerProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  useDismiss(!!anchor, popoverRef, () => setAnchor(null));

  const current = ALIGNS.find((a) => a.value === value) ?? ALIGNS[0];
  const pos = anchorPosition(anchor, 184, 96);

  function pick(entry: AlignEntry) {
    onChange(entry.value);
    void dispatchSlideCommand(entry.cmd);
    setAnchor(null);
  }

  return (
    <div className="cs-toolbar2__split">
      <button
        ref={triggerRef}
        type="button"
        className="cs-toolbar2__btn cs-toolbar2__btn--with-caret"
        title={t('toolbar.align')}
        aria-label={t('toolbar.align')}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={() => setAnchor(anchor ? null : triggerRef.current!.getBoundingClientRect())}
      >
        <Icon name={current.icon} size={18} filled />
        <Icon name="expand_more" size={14} className="cs-toolbar2__caret" />
      </button>
      {pos && (
        <div
          ref={popoverRef}
          className="cs-toolbar2__popover cs-toolbar2__popover--align"
          role="dialog"
          aria-label={t('toolbar.align')}
          style={{ top: pos.top, left: pos.left }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="cs-toolbar2__segmented">
            {ALIGNS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                className={`cs-toolbar2__btn ${value === entry.value ? 'is-active' : ''}`}
                aria-pressed={value === entry.value}
                title={t(entry.labelKey)}
                aria-label={t(entry.labelKey)}
                onClick={() => pick(entry)}
              >
                <Icon name={entry.icon} size={18} filled={value === entry.value} />
              </button>
            ))}
          </div>
          {/* TODO(univer): vertical-align is gap-listed in
              docs/UNIVER_SLIDES_GAPS.md — needs a slide.mutation.update-element
              patch that writes `shape.anchor` on the selected frame. */}
        </div>
      )}
    </div>
  );
}
