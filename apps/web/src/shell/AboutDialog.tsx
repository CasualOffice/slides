import { useEffect, useRef } from 'react';
import { Icon } from './icons';
import { useFocusTrap } from './use-focus-trap';

// Help → About modal. Static content — version, license, repo, the
// open-source dependencies we ship on top of. Same backdrop / centred-
// card idiom as PropertiesDialog / RecentFilesDialog / ThemePicker.

export interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
}

interface Attribution {
  name: string;
  license: string;
  url: string;
  note?: string;
}

const ATTRIBUTIONS: Attribution[] = [
  {
    name: 'Univer OSS',
    license: 'Apache-2.0',
    url: 'https://github.com/dream-num/univer',
    note: 'Slides canvas + data model (v0.24.0).',
  },
  {
    name: 'PptxGenJS',
    license: 'MIT',
    url: 'https://github.com/gitbrent/PptxGenJS',
    note: '.pptx export pipeline.',
  },
  {
    name: 'JSZip',
    license: 'MIT or GPL-3.0 (we use MIT)',
    url: 'https://github.com/Stuk/jszip',
    note: '.pptx zip read/write.',
  },
  {
    name: 'fast-xml-parser',
    license: 'MIT',
    url: 'https://github.com/NaturalIntelligence/fast-xml-parser',
    note: 'OOXML parsing.',
  },
  {
    name: 'React',
    license: 'MIT',
    url: 'https://react.dev/',
    note: 'UI shell.',
  },
  {
    name: 'Material Symbols',
    license: 'Apache-2.0',
    url: 'https://fonts.google.com/icons',
    note: 'Toolbar + menu icons.',
  },
];

export function AboutDialog({ open, onClose }: AboutDialogProps) {
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
    <div className="cs-about__backdrop" role="dialog" aria-modal="true" aria-label="About Casual Slides">
      <div className="cs-about" ref={dialogRef} data-testid="about-dialog" tabIndex={-1}>
        <header className="cs-about__header">
          <Icon name="info" size={16} />
          <h2 className="cs-about__title">About Casual Slides</h2>
          <button
            type="button"
            className="cs-about__close"
            onClick={onClose}
            title="Close (Esc)"
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
            <h3 className="cs-about__product">Casual Slides</h3>
            <p className="cs-about__tagline">
              Web-based PowerPoint-equivalent — built on Univer OSS, licensed Apache-2.0.
            </p>
          </div>
        </section>

        <dl className="cs-about__meta">
          <div className="cs-about__row">
            <dt>License</dt>
            <dd>Apache-2.0</dd>
          </div>
          <div className="cs-about__row">
            <dt>Source</dt>
            <dd>
              <a
                href="https://github.com/schnsrw/slides"
                target="_blank"
                rel="noreferrer noopener"
              >
                github.com/schnsrw/slides
              </a>
            </dd>
          </div>
          <div className="cs-about__row">
            <dt>Live</dt>
            <dd>
              <a
                href="https://slide.schnsrw.live"
                target="_blank"
                rel="noreferrer noopener"
              >
                slide.schnsrw.live
              </a>
            </dd>
          </div>
        </dl>

        <section className="cs-about__attrib">
          <h4 className="cs-about__attrib-title">Open-source dependencies</h4>
          <ul className="cs-about__attrib-list">
            {ATTRIBUTIONS.map((a) => (
              <li key={a.name} className="cs-about__attrib-item">
                <div className="cs-about__attrib-row">
                  <a href={a.url} target="_blank" rel="noreferrer noopener">
                    {a.name}
                  </a>
                  <span className="cs-about__attrib-license">{a.license}</span>
                </div>
                {a.note && <p className="cs-about__attrib-note">{a.note}</p>}
              </li>
            ))}
          </ul>
        </section>

        <footer className="cs-about__footer">
          <button type="button" className="cs-btn cs-btn--ghost" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
