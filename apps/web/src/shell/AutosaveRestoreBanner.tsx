import type { AutosaveRecord } from '../storage/autosave';
import { useTranslation } from '../i18n';

// Bottom-anchored snackbar that surfaces on mount when an autosave
// record is present. Non-blocking — the user can keep editing the
// default deck without acting on it. Acting is a deliberate Restore
// (replaces the current deck) or Dismiss (deletes the autosave).

export interface AutosaveRestoreBannerProps {
  offer: AutosaveRecord | null;
  onRestore: (record: AutosaveRecord) => void;
  onDismiss: () => void;
}

function formatRelative(epochMs: number, locale: string): string {
  const diff = Math.max(0, Date.now() - epochMs);
  const min = Math.round(diff / 60_000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (min < 1) return formatter.format(0, 'minute');
  if (min < 60) return formatter.format(-min, 'minute');
  const hr = Math.round(min / 60);
  if (hr < 24) return formatter.format(-hr, 'hour');
  const day = Math.round(hr / 24);
  return formatter.format(-day, 'day');
}

export function AutosaveRestoreBanner({ offer, onRestore, onDismiss }: AutosaveRestoreBannerProps) {
  const { t, i18n } = useTranslation('chrome');
  if (!offer) return null;
  const when = formatRelative(offer.savedAt, i18n.resolvedLanguage ?? i18n.language);
  return (
    <div
      className="cs-autosave-banner"
      role="status"
      aria-live="polite"
      data-testid="autosave-banner"
    >
      <div className="cs-autosave-banner__text">
        <strong>{t('autosave.title')}</strong>
        <span>{t('autosave.subtitle', { name: offer.fileName, when })}</span>
      </div>
      <div className="cs-autosave-banner__actions">
        <button
          type="button"
          className="cs-btn cs-btn--ghost"
          onClick={onDismiss}
        >
          {t('autosave.dismiss')}
        </button>
        <button
          type="button"
          className="cs-btn cs-btn--accent"
          onClick={() => onRestore(offer)}
        >
          {t('autosave.restore')}
        </button>
      </div>
    </div>
  );
}
