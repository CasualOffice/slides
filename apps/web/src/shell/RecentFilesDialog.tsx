import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { RecentMeta } from '../storage/recent-files';
import { clearRecents, listRecents, loadRecent, removeRecent, setRecentPinned } from '../storage/recent-files';
import { useTranslation } from '../i18n';
import { Icon } from './icons';
import { useFocusTrap } from './use-focus-trap';

// File → Recent files modal. Lists up to 10 recently opened decks from
// IndexedDB; selecting one reopens it through the same import path the
// file-picker uses.
//
// Backdrop / centred-card idiom matches PropertiesDialog + ThemePicker.

export interface RecentFilesDialogProps {
  open: boolean;
  onClose: () => void;
  onOpen: (bytes: ArrayBuffer, fileName: string) => void;
}

function formatSize(bytes: number, t: TFunction<'dialogs'>): string {
  if (bytes < 1024) return t('recent.size.bytes', { value: bytes });
  if (bytes < 1024 * 1024) return t('recent.size.kilobytes', { value: (bytes / 1024).toFixed(1) });
  return t('recent.size.megabytes', { value: (bytes / 1024 / 1024).toFixed(2) });
}

function formatRelative(epoch: number, t: TFunction<'dialogs'>, locale: string): string {
  const diffMs = Date.now() - epoch;
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return t('recent.relative.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('recent.relative.minutes', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('recent.relative.hours', { count: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return t('recent.relative.days', { count: day });
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(epoch);
}

export function RecentFilesDialog({ open, onClose, onOpen }: RecentFilesDialogProps) {
  const { t, i18n } = useTranslation('dialogs');
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, dialogRef);
  const [entries, setEntries] = useState<RecentMeta[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await listRecents();
      setEntries(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setEntries(null);
    void refresh();
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
  }, [open, onClose, refresh]);

  const handleOpen = useCallback(
    async (entry: RecentMeta) => {
      setBusy(true);
      setError(null);
      try {
        const bytes = await loadRecent(entry.id);
        if (!bytes) {
          setError(t('recent.entryUnavailable'));
          await refresh();
          return;
        }
        onOpen(bytes, entry.name);
        onClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [onClose, onOpen, refresh, t],
  );

  const handleRemove = useCallback(
    async (entry: RecentMeta, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await removeRecent(entry.id);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  const handleTogglePin = useCallback(
    async (entry: RecentMeta, e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await setRecentPinned(entry.id, !entry.pinned);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [refresh],
  );

  const handleClear = useCallback(async () => {
    try {
      await clearRecents();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  if (!open) return null;

  return (
    <div className="cs-recent__backdrop" role="dialog" aria-modal="true" aria-label={t('recent.ariaLabel')}>
      <div className="cs-recent" ref={dialogRef} data-testid="recent-dialog" tabIndex={-1}>
        <header className="cs-recent__header">
          <Icon name="history" size={16} />
          <h2 className="cs-recent__title">{t('recent.title')}</h2>
          <button
            type="button"
            className="cs-recent__close"
            onClick={onClose}
            title={t('recent.closeTooltip')}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        {entries === null && !error && (
          <p className="cs-recent__empty">{t('recent.loading')}</p>
        )}

        {entries && entries.length === 0 && !error && (
          <p className="cs-recent__empty">
            {t('recent.empty')}
          </p>
        )}

        {entries && entries.length > 0 && (
          <ul className="cs-recent__list" data-testid="recent-list">
            {entries.map((entry) => (
              <li key={entry.id} className={`cs-recent__item${entry.pinned ? ' cs-recent__item--pinned' : ''}`}>
                <button
                  type="button"
                  className="cs-recent__open"
                  disabled={busy}
                  onClick={() => void handleOpen(entry)}
                  title={t('recent.openTooltip', { name: entry.name })}
                  aria-label={t('recent.openTooltip', { name: entry.name })}
                  data-testid="recent-item"
                  data-recent-name={entry.name}
                >
                  <Icon name="slideshow" size={20} />
                  <span className="cs-recent__name">{entry.name}</span>
                  <span className="cs-recent__meta">
                    {t('recent.meta', {
                      size: formatSize(entry.size, t),
                      relative: formatRelative(
                        entry.openedAt,
                        t,
                        i18n.resolvedLanguage ?? i18n.language,
                      ),
                    })}
                  </span>
                </button>
                <button
                  type="button"
                  className={`cs-recent__pin${entry.pinned ? ' cs-recent__pin--on' : ''}`}
                  onClick={(e) => void handleTogglePin(entry, e)}
                  title={entry.pinned ? t('recent.unpin') : t('recent.pinToTop')}
                  aria-label={entry.pinned
                    ? t('recent.unpinAriaLabel', { name: entry.name })
                    : t('recent.pinAriaLabel', { name: entry.name })}
                  aria-pressed={!!entry.pinned}
                >
                  <Icon name="star" size={14} filled={!!entry.pinned} />
                </button>
                <button
                  type="button"
                  className="cs-recent__remove"
                  onClick={(e) => void handleRemove(entry, e)}
                  title={t('recent.removeTooltip')}
                  aria-label={t('recent.removeAriaLabel', { name: entry.name })}
                >
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="cs-recent__error" role="alert" aria-live="assertive">{error}</p>}

        <footer className="cs-recent__footer">
          {entries && entries.length > 0 && (
            <button
              type="button"
              className="cs-btn cs-btn--ghost"
              onClick={() => void handleClear()}
            >
              {t('recent.clearAll')}
            </button>
          )}
          <button type="button" className="cs-btn cs-btn--ghost" onClick={onClose}>
            {t('recent.close')}
          </button>
        </footer>
      </div>
    </div>
  );
}
