import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecentMeta } from '../storage/recent-files';
import { clearRecents, listRecents, loadRecent, removeRecent } from '../storage/recent-files';
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatRelative(epoch: number): string {
  const diffMs = Date.now() - epoch;
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  return new Date(epoch).toLocaleDateString();
}

export function RecentFilesDialog({ open, onClose, onOpen }: RecentFilesDialogProps) {
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
          setError('Entry no longer available.');
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
    [onClose, onOpen, refresh],
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
    <div className="cs-recent__backdrop" role="dialog" aria-modal="true" aria-label="Recent files">
      <div className="cs-recent" ref={dialogRef} data-testid="recent-dialog" tabIndex={-1}>
        <header className="cs-recent__header">
          <Icon name="history" size={16} />
          <h2 className="cs-recent__title">Recent files</h2>
          <button
            type="button"
            className="cs-recent__close"
            onClick={onClose}
            title="Close (Esc)"
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        {entries === null && !error && (
          <p className="cs-recent__empty">Loading…</p>
        )}

        {entries && entries.length === 0 && !error && (
          <p className="cs-recent__empty">
            No recent decks yet. Open a .pptx and it'll appear here.
          </p>
        )}

        {entries && entries.length > 0 && (
          <ul className="cs-recent__list" data-testid="recent-list">
            {entries.map((entry) => (
              <li key={entry.id} className="cs-recent__item">
                <button
                  type="button"
                  className="cs-recent__open"
                  disabled={busy}
                  onClick={() => void handleOpen(entry)}
                  title={`Open ${entry.name}`}
                  data-testid="recent-item"
                  data-recent-name={entry.name}
                >
                  <Icon name="slideshow" size={20} />
                  <span className="cs-recent__name">{entry.name}</span>
                  <span className="cs-recent__meta">
                    {formatSize(entry.size)} · {formatRelative(entry.openedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  className="cs-recent__remove"
                  onClick={(e) => void handleRemove(entry, e)}
                  title="Remove from list"
                  aria-label={`Remove ${entry.name}`}
                >
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {error && <p className="cs-recent__error">{error}</p>}

        <footer className="cs-recent__footer">
          {entries && entries.length > 0 && (
            <button
              type="button"
              className="cs-btn cs-btn--ghost"
              onClick={() => void handleClear()}
            >
              Clear all
            </button>
          )}
          <button type="button" className="cs-btn cs-btn--ghost" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
