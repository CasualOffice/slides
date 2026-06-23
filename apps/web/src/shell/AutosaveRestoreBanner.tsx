import type { AutosaveRecord } from '../storage/autosave';

// Bottom-anchored snackbar that surfaces on mount when an autosave
// record is present. Non-blocking — the user can keep editing the
// default deck without acting on it. Acting is a deliberate Restore
// (replaces the current deck) or Dismiss (deletes the autosave).

export interface AutosaveRestoreBannerProps {
  offer: AutosaveRecord | null;
  onRestore: (record: AutosaveRecord) => void;
  onDismiss: () => void;
}

function formatRelative(epochMs: number): string {
  const diff = Math.max(0, Date.now() - epochMs);
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'less than a minute ago';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

export function AutosaveRestoreBanner({ offer, onRestore, onDismiss }: AutosaveRestoreBannerProps) {
  if (!offer) return null;
  const when = formatRelative(offer.savedAt);
  return (
    <div
      className="cs-autosave-banner"
      role="status"
      aria-live="polite"
      data-testid="autosave-banner"
    >
      <div className="cs-autosave-banner__text">
        {/* TODO(i18n): chrome.autosave.* once W1b lands. */}
        <strong>Restore unsaved deck?</strong>
        <span>{offer.fileName} · last edited {when}</span>
      </div>
      <div className="cs-autosave-banner__actions">
        <button
          type="button"
          className="cs-btn cs-btn--ghost"
          onClick={onDismiss}
        >
          Discard
        </button>
        <button
          type="button"
          className="cs-btn cs-btn--accent"
          onClick={() => onRestore(offer)}
        >
          Restore
        </button>
      </div>
    </div>
  );
}
