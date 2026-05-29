import { useEffect, useMemo, useRef } from 'react';
import type { Univer } from '@univerjs/core';
import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { ISlideData, SlideDataModel } from '@univerjs/slides';
import { PageElementType } from '@univerjs/slides';
import { Icon } from './icons';
import { useFocusTrap } from './use-focus-trap';
import { useTranslation } from '../i18n';

// File → Properties modal. Read-only metadata about the active deck.
// Same backdrop / centred-card idiom as ThemePicker; key/value rows
// inside.

export interface PropertiesDialogProps {
  open: boolean;
  onClose: () => void;
  fallback: ISlideData;
}

interface DeckStats {
  title: string;
  slideCount: number;
  pageWidth: number;
  pageHeight: number;
  elementCount: number;
  textChars: number;
}

function getLiveSnapshot(fallback: ISlideData): ISlideData {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return fallback;
  try {
    const instances = univer.__getInjector().get(IUniverInstanceService);
    const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
    return model?.getSnapshot() ?? fallback;
  } catch {
    return fallback;
  }
}

function computeStats(snapshot: ISlideData): DeckStats {
  const pages = snapshot.body?.pages ?? {};
  const order = snapshot.body?.pageOrder ?? [];
  let elementCount = 0;
  let textChars = 0;
  for (const id of order) {
    const page = pages[id];
    if (!page) continue;
    const elements = Object.values(page.pageElements ?? {});
    elementCount += elements.length;
    for (const e of elements) {
      if (e.type === PageElementType.TEXT && e.richText?.text) {
        textChars += e.richText.text.length;
      } else if (e.shape?.text) {
        textChars += e.shape.text.length;
      }
    }
  }
  return {
    title: (snapshot.title || 'Untitled deck').trim(),
    slideCount: order.length,
    pageWidth: snapshot.pageSize?.width ?? 960,
    pageHeight: snapshot.pageSize?.height ?? 540,
    elementCount,
    textChars,
  };
}

function formatInches(px: number): string {
  const inches = px / 96;
  return inches.toFixed(2);
}

export function PropertiesDialog({ open, onClose, fallback }: PropertiesDialogProps) {
  const { t } = useTranslation('dialogs');
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, dialogRef);

  // Read the snapshot ONCE when the dialog opens; static for the dialog's
  // lifetime. Re-open to refresh after edits.
  const stats = useMemo<DeckStats | null>(
    () => (open ? computeStats(getLiveSnapshot(fallback)) : null),
    [open, fallback],
  );

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!dialogRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open || !stats) return null;

  return (
    <div className="cs-properties__backdrop" role="dialog" aria-modal="true" aria-label={t('properties.ariaLabel')}>
      <div className="cs-properties" ref={dialogRef} data-testid="properties-dialog" tabIndex={-1}>
        <header className="cs-properties__header">
          <Icon name="info" size={16} />
          <h2 className="cs-properties__title">{t('properties.title')}</h2>
          <button
            type="button"
            className="cs-properties__close"
            onClick={onClose}
            title={t('properties.closeTooltip')}
          >
            <Icon name="close" size={16} />
          </button>
        </header>
        <dl className="cs-properties__list">
          <PropRow testId="title" label={t('properties.keys.title')} value={stats.title} />
          <PropRow testId="slides" label={t('properties.keys.slides')} value={String(stats.slideCount)} />
          <PropRow
            testId="page-size"
            label={t('properties.keys.pageSize')}
            value={t('properties.values.pageSize', {
              width: stats.pageWidth,
              height: stats.pageHeight,
              widthIn: formatInches(stats.pageWidth),
              heightIn: formatInches(stats.pageHeight),
            })}
          />
          <PropRow testId="elements" label={t('properties.keys.elements')} value={String(stats.elementCount)} />
          <PropRow
            testId="text-length"
            label={t('properties.keys.textLength')}
            value={t('properties.values.textCharacters', { count: stats.textChars })}
          />
          <PropRow testId="format" label={t('properties.keys.format')} value={t('properties.values.format')} />
        </dl>
        <footer className="cs-properties__footer">
          <button type="button" className="cs-btn cs-btn--ghost" onClick={onClose}>
            {t('properties.close')}
          </button>
        </footer>
      </div>
    </div>
  );
}

function PropRow({ testId, label, value }: { testId: string; label: string; value: string }) {
  return (
    <div className="cs-properties__row" data-testid={`prop-${testId}`}>
      <dt className="cs-properties__key">{label}</dt>
      <dd className="cs-properties__value">{value}</dd>
    </div>
  );
}
