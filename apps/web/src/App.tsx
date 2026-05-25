import { useEffect, useMemo, useRef, useState } from 'react';
import type { ISlideData, SlideDataModel } from '@univerjs/slides';
import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { Univer } from '@univerjs/core';

import { UniverSlide } from './UniverSlide';
import { getPptxClient } from './pptx/client';
import { DEFAULT_SLIDE_DATA } from './default-slide';
import { TitleBar } from './shell/TitleBar';
import { Toolbar } from './shell/Toolbar';
import { StatusBar } from './shell/StatusBar';
import { SlideShow } from './shell/SlideShow';
import { NotesPanel } from './shell/NotesPanel';
import { ThemePicker } from './shell/ThemePicker';
import { dispatchSlideCommand } from './univer/commands';

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getCurrentSnapshot(fallback: ISlideData): ISlideData {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return fallback;
  const instances = univer.__getInjector().get(IUniverInstanceService);
  const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
  return model?.getSnapshot() ?? fallback;
}

function deckTitle(snapshot: ISlideData): string {
  const t = (snapshot.title || '').trim();
  return t || 'Untitled deck';
}

export function App() {
  // Active deck. UniverSlide is keyed on snapshot.id — when Open .pptx
  // imports a new deck, the state update + key change forces React to
  // unmount + remount UniverSlide, which spins up a fresh Univer instance
  // against the new snapshot. swapDeck via disposeUnit + createUnit
  // doesn't reliably rebind the canvas to our container; remount does.
  const [snapshot, setSnapshot] = useState<ISlideData>(DEFAULT_SLIDE_DATA);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slideshowOpen, setSlideshowOpen] = useState(false);
  const [notesVisible, setNotesVisible] = useState(true);
  const [themesOpen, setThemesOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Expose to the Toolbar (which lives outside App's prop tree).
  useEffect(() => {
    window.__casualSlides_openSlideshow = () => setSlideshowOpen(true);
    window.__casualSlides_toggleNotes = () => setNotesVisible((v) => !v);
    window.__casualSlides_openThemes = () => setThemesOpen(true);
    return () => {
      delete window.__casualSlides_openSlideshow;
      delete window.__casualSlides_toggleNotes;
      delete window.__casualSlides_openThemes;
    };
  }, []);

  const fileName = useMemo(() => deckTitle(snapshot), [snapshot]);
  const slideCount = snapshot.body?.pageOrder?.length ?? 0;

  // Global keyboard shortcuts. Each guards on the active element NOT being
  // an editable input (text-frame editor inside Univer manages its own
  // shortcuts; we don't want to step on those).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditable = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      );
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (inEditable && k !== 'p' && k !== 's' && k !== 'o') return;

      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        void dispatchSlideCommand('univer.command.undo');
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        void dispatchSlideCommand('univer.command.redo');
      } else if (k === 'm') {
        e.preventDefault();
        void dispatchSlideCommand('slide.operation.append-slide');
      } else if (k === 'p') {
        e.preventDefault();
        window.print();
      } else if (k === 's') {
        e.preventDefault();
        void handleSavePptx();
      } else if (k === 'o') {
        e.preventDefault();
        handleOpenClick();
      }
    };
    const f5Handler = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault();
        setSlideshowOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    window.addEventListener('keydown', f5Handler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('keydown', f5Handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSavePptx() {
    setError(null);
    setStatus(null);
    setSaving(true);
    try {
      const live = getCurrentSnapshot(snapshot);
      const out: ISlideData = { ...live, title: fileName };
      const { blob, fileName: producedName } = await getPptxClient().export(out);
      downloadBlob(blob, producedName);
      setStatus(`Saved · ${(blob.size / 1024).toFixed(1)} KB`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function handleOpenClick() {
    fileInputRef.current?.click();
  }

  async function handleOpenPptx(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    setStatus(null);
    setOpening(true);
    try {
      const buffer = await file.arrayBuffer();
      const imported = await getPptxClient().import(buffer, file.name);
      const pageCount = imported.body?.pageOrder.length ?? 0;
      setSnapshot(imported);
      const w = window as unknown as { __pptxImportedSnapshot?: unknown };
      w.__pptxImportedSnapshot = imported;
      setStatus(`Loaded · ${pageCount} slide${pageCount === 1 ? '' : 's'}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  }

  function handleFileNameChange(next: string) {
    setSnapshot({ ...snapshot, title: next });
  }

  return (
    <>
      <TitleBar
        fileName={fileName}
        onFileNameChange={handleFileNameChange}
        onOpen={handleOpenClick}
        onSave={handleSavePptx}
        saving={saving}
        opening={opening}
        status={status}
        error={error}
      />
      <Toolbar />
      <input
        ref={fileInputRef}
        type="file"
        accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
        style={{ display: 'none' }}
        onChange={handleOpenPptx}
      />
      <div className="cs-workspace">
        <UniverSlide key={snapshot.id} snapshot={snapshot} />
      </div>
      <NotesPanel visible={notesVisible} onToggle={() => setNotesVisible((v) => !v)} />
      <StatusBar
        slideCount={slideCount}
        notesVisible={notesVisible}
        onToggleNotes={() => setNotesVisible((v) => !v)}
      />
      {slideshowOpen && (
        <SlideShow snapshot={snapshot} onExit={() => setSlideshowOpen(false)} />
      )}
      <ThemePicker open={themesOpen} onClose={() => setThemesOpen(false)} />
    </>
  );
}

// Expose a global to let the Toolbar slideshow button trigger via the same
// state. Keeps Toolbar.tsx out of the App's prop tree.
declare global {
  interface Window {
    __casualSlides_openSlideshow?: () => void;
    __casualSlides_toggleNotes?: () => void;
    __casualSlides_openThemes?: () => void;
  }
}
