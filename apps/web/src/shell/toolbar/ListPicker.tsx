// Bulleted / numbered list toggle. Two independent buttons (mirrors Google
// Slides), each dispatching the matching Univer docs-ui list command.
//
// Indent decrease / increase live in the toolbar root, not here — Google
// Slides surfaces them as standalone icons. The handler dispatches
// `doc.command.change-list-nesting-level` with `{ type: 'increase' | 'decrease' }`,
// which Univer also uses for non-list indentation (paragraph indent rewrites
// the same paragraph-margin field).
import { dispatchSlideCommand } from '../../univer/commands';
import { Icon } from '../icons';
import { useTranslation } from '../../i18n';

export type ListMode = 'none' | 'bullet' | 'number';

export interface ListPickerProps {
  mode: ListMode;
  onChange: (mode: ListMode) => void;
}

export function ListPicker({ mode, onChange }: ListPickerProps) {
  const { t } = useTranslation();

  function toggle(target: 'bullet' | 'number') {
    onChange(mode === target ? 'none' : target);
    void dispatchSlideCommand(
      target === 'bullet' ? 'doc.command.bullet-list' : 'doc.command.order-list',
    );
  }

  return (
    <>
      <button
        type="button"
        className={`cs-toolbar2__btn ${mode === 'bullet' ? 'is-active' : ''}`}
        title={t('toolbar.listBulleted')}
        aria-label={t('toolbar.listBulleted')}
        aria-pressed={mode === 'bullet'}
        onClick={() => toggle('bullet')}
      >
        <Icon name="format_list_bulleted" size={16} />
      </button>
      <button
        type="button"
        className={`cs-toolbar2__btn ${mode === 'number' ? 'is-active' : ''}`}
        title={t('toolbar.listNumbered')}
        aria-label={t('toolbar.listNumbered')}
        aria-pressed={mode === 'number'}
        onClick={() => toggle('number')}
      >
        <Icon name="format_list_numbered" size={16} />
      </button>
    </>
  );
}
