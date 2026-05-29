import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons';
import { useFocusTrap } from './use-focus-trap';
import { useTranslation } from '../i18n';

// File → Page setup. Changes the deck's slide dimensions. Applying re-keys
// the deck (App bumps snapshot.id) which remounts the Univer canvas at the
// new size — Univer caches the slide rect at mount, so a live pageSize write
// alone does not re-fit; the remount is the reliable path (same one the
// .pptx import flow uses). Backdrop / centred-card idiom matches the other
// dialogs.

export interface PageSetupDialogProps {
  open: boolean;
  onClose: () => void;
  current: { width: number; height: number };
  onApply: (width: number, height: number) => void;
}

interface Preset {
  id: string;
  labelKey: string;
  width: number;
  height: number;
}

// 96px/inch. Widescreen 10"×5.63" and Standard 10"×7.5" — the PowerPoint
// defaults, matching the app's 960×540 base.
const PRESETS: Preset[] = [
  { id: 'wide', labelKey: 'widescreen', width: 960, height: 540 },
  { id: 'standard', labelKey: 'standard', width: 960, height: 720 },
];

function matchPreset(w: number, h: number): string {
  const p = PRESETS.find((x) => x.width === w && x.height === h);
  return p ? p.id : 'custom';
}

export function PageSetupDialog({ open, onClose, current, onApply }: PageSetupDialogProps) {
  const { t } = useTranslation('dialogs');
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(open, dialogRef);

  const initialSel = useMemo(() => matchPreset(current.width, current.height), [current]);
  const [sel, setSel] = useState(initialSel);
  const [customW, setCustomW] = useState(String(current.width));
  const [customH, setCustomH] = useState(String(current.height));

  useEffect(() => {
    if (open) {
      setSel(matchPreset(current.width, current.height));
      setCustomW(String(current.width));
      setCustomH(String(current.height));
    }
  }, [open, current]);

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

  const apply = () => {
    let w: number;
    let h: number;
    if (sel === 'custom') {
      w = Math.round(Number(customW));
      h = Math.round(Number(customH));
    } else {
      const p = PRESETS.find((x) => x.id === sel)!;
      w = p.width;
      h = p.height;
    }
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 100 || h < 100 || w > 4000 || h > 4000) {
      return; // ignore invalid; inputs are clamped in the UI too
    }
    if (w !== current.width || h !== current.height) onApply(w, h);
    onClose();
  };

  return (
    <div className="cs-pagesetup__backdrop" role="dialog" aria-modal="true" aria-label={t('pageSetup.ariaLabel')}>
      <div className="cs-pagesetup" ref={dialogRef} tabIndex={-1}>
        <header className="cs-pagesetup__header">
          <Icon name="straighten" size={16} />
          <h2 className="cs-pagesetup__title">{t('pageSetup.title')}</h2>
          <button type="button" className="cs-pagesetup__close" onClick={onClose} title={t('pageSetup.close')}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="cs-pagesetup__body">
          {PRESETS.map((p) => (
            <label key={p.id} className="cs-pagesetup__option">
              <input
                type="radio"
                name="pagesetup"
                checked={sel === p.id}
                onChange={() => setSel(p.id)}
              />
              <span className="cs-pagesetup__option-label">{t(`pageSetup.${p.labelKey}`)}</span>
              <span className="cs-pagesetup__option-dim">{p.width} × {p.height}</span>
            </label>
          ))}
          <label className="cs-pagesetup__option">
            <input
              type="radio"
              name="pagesetup"
              checked={sel === 'custom'}
              onChange={() => setSel('custom')}
            />
            <span className="cs-pagesetup__option-label">{t('pageSetup.custom')}</span>
          </label>
          {sel === 'custom' && (
            <div className="cs-pagesetup__custom">
              <label>
                <span>{t('pageSetup.width')}</span>
                <input
                  type="number"
                  min={100}
                  max={4000}
                  value={customW}
                  onChange={(e) => setCustomW(e.target.value)}
                />
              </label>
              <span className="cs-pagesetup__times">×</span>
              <label>
                <span>{t('pageSetup.height')}</span>
                <input
                  type="number"
                  min={100}
                  max={4000}
                  value={customH}
                  onChange={(e) => setCustomH(e.target.value)}
                />
              </label>
              <span className="cs-pagesetup__unit">px</span>
            </div>
          )}
          <p className="cs-pagesetup__note">{t('pageSetup.note')}</p>
        </div>
        <footer className="cs-pagesetup__footer">
          <button type="button" className="cs-btn cs-btn--ghost" onClick={onClose}>
            {t('pageSetup.cancel')}
          </button>
          <button type="button" className="cs-btn cs-btn--accent" onClick={apply}>
            {t('pageSetup.apply')}
          </button>
        </footer>
      </div>
    </div>
  );
}
