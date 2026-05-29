import { useEffect, useRef } from 'react';
import { Icon } from './icons';
import { useFocusTrap } from './use-focus-trap';
import { useTranslation } from '../i18n';

// Help → About modal. Static content — version, license, repo, the
// open-source dependencies we ship on top of. Same backdrop / centred-
// card idiom as PropertiesDialog / RecentFilesDialog / ThemePicker.

export interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

// Dependency display text (name / license / note) is i18n-keyed under
// dialogs.about.deps.<key>; only the URL stays here (URLs don't translate).
const ATTRIBUTIONS: { key: string; url: string }[] = [
  { key: 'univer', url: 'https://github.com/dream-num/univer' },
  { key: 'pptxgenjs', url: 'https://github.com/gitbrent/PptxGenJS' },
  { key: 'jszip', url: 'https://github.com/Stuk/jszip' },
  { key: 'fastXmlParser', url: 'https://github.com/NaturalIntelligence/fast-xml-parser' },
  { key: 'react', url: 'https://react.dev/' },
  { key: 'lucide', url: 'https://lucide.dev/' },
  { key: 'i18next', url: 'https://www.i18next.com/' },
];

export function AboutDialog({ open, onClose }: AboutDialogProps) {
  const { t } = useTranslation('dialogs');
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, dialogRef);

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

  if (!open) return null;

  return (
    <div className="cs-about__backdrop" role="dialog" aria-modal="true" aria-label={t('about.ariaLabel')}>
      <div className="cs-about" ref={dialogRef} data-testid="about-dialog" tabIndex={-1}>
        <header className="cs-about__header">
          <Icon name="info" size={16} />
          <h2 className="cs-about__title">{t('about.title')}</h2>
          <button
            type="button"
            className="cs-about__close"
            onClick={onClose}
            title={t('about.closeTooltip')}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        <section className="cs-about__hero">
          <svg viewBox="0 0 32 40" width="44" height="55" aria-hidden="true">
            <path d="M2 0C0.9 0 0 0.9 0 2V38C0 39.1 0.9 40 2 40H30C31.1 40 32 39.1 32 38V10L22 0H2Z" fill="#0891B2" />
            <path d="M22 0L32 10H24C22.9 10 22 9.1 22 8V0Z" fill="#0E7490" />
            <rect x="6" y="17" width="20" height="14" rx="1" fill="#fff" opacity="0.95" />
            <rect x="8" y="19" width="10" height="2" rx="0.5" fill="#0891B2" />
            <rect x="8" y="23" width="14" height="1.5" rx="0.5" fill="#0891B2" opacity="0.7" />
            <rect x="8" y="26" width="10" height="1.5" rx="0.5" fill="#0891B2" opacity="0.7" />
            <path d="M20.5 26 L24 27.75 L20.5 29.5 Z" fill="#0891B2" />
          </svg>
          <div>
            <h3 className="cs-about__product">{t('about.product')}</h3>
            <p className="cs-about__tagline">{t('about.tagline')}</p>
          </div>
        </section>

        <dl className="cs-about__meta">
          <div className="cs-about__row">
            <dt>{t('about.license')}</dt>
            <dd>{t('about.licenseValue')}</dd>
          </div>
          <div className="cs-about__row">
            <dt>{t('about.source')}</dt>
            <dd>
              <a
                href="https://github.com/schnsrw/slides"
                target="_blank"
                rel="noreferrer noopener"
              >
                {t('about.sourceLink')}
              </a>
            </dd>
          </div>
          <div className="cs-about__row">
            <dt>{t('about.live')}</dt>
            <dd>
              <a
                href="https://slide.schnsrw.live"
                target="_blank"
                rel="noreferrer noopener"
              >
                {t('about.liveLink')}
              </a>
            </dd>
          </div>
        </dl>

        <section className="cs-about__attrib">
          <h4 className="cs-about__attrib-title">{t('about.attribTitle')}</h4>
          <ul className="cs-about__attrib-list">
            {ATTRIBUTIONS.map((a) => (
              <li key={a.key} className="cs-about__attrib-item">
                <div className="cs-about__attrib-row">
                  <a href={a.url} target="_blank" rel="noreferrer noopener">
                    {t(`about.deps.${a.key}.name`)}
                  </a>
                  <span className="cs-about__attrib-license">{t(`about.deps.${a.key}.license`)}</span>
                </div>
                <p className="cs-about__attrib-note">{t(`about.deps.${a.key}.note`)}</p>
              </li>
            ))}
          </ul>
        </section>

        <footer className="cs-about__footer">
          <button type="button" className="cs-btn cs-btn--ghost" onClick={onClose}>
            {t('about.close')}
          </button>
        </footer>
      </div>
    </div>
  );
}
