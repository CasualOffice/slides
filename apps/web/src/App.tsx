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
import { PropertiesDialog } from './shell/PropertiesDialog';
import { RecentFilesDialog } from './shell/RecentFilesDialog';
import { SlideContextMenu } from './shell/SlideContextMenu';
import { dispatchSlideCommand } from './univer/commands';
import { useCollabBridge } from './collab/CollabProvider';
import { addRecent } from './storage/recent-files';

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
  // Speaker notes default to hidden — most users never write them on a
  // fresh deck. Once the user enables them, we persist via localStorage
  // so reload restores the preference. Key is intentionally narrow
  // (`cs.notesVisible`) so we don't collide with the future profile
  // settings layer.
  const [notesVisible, setNotesVisible] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem('cs.notesVisible') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('cs.notesVisible', notesVisible ? '1' : '0');
    } catch {
      /* private mode etc — ignore */
    }
  }, [notesVisible]);
  const [themesOpen, setThemesOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
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
  const collab = useCollabBridge();

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
      } else if (k === 'd') {
        // Ctrl+D — duplicate active slide. Overrides browser bookmark
        // (Google Slides does the same).
        e.preventDefault();
        void dispatchSlideCommand('slide.command.duplicate-slide');
      }
    };
    const deleteSlideHandler = (e: KeyboardEvent) => {
      // Bare Delete key. Skip if focus is in any editable surface — the
      // text-frame editor uses Delete for character deletion.
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const target = e.target as HTMLElement | null;
      const inEditable = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      );
      if (inEditable) return;
      // Shift+Delete acts on the active slide as a guarded variant —
      // bare Delete should not delete slides unless focus is on the
      // slide-bar, which we don't track today.
      if (!e.shiftKey) return;
      e.preventDefault();
      void dispatchSlideCommand('slide.command.delete-slide');
    };
    const f5Handler = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault();
        setSlideshowOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    window.addEventListener('keydown', f5Handler);
    window.addEventListener('keydown', deleteSlideHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('keydown', f5Handler);
      window.removeEventListener('keydown', deleteSlideHandler);
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

  // Shared import path. `persist` controls whether we save the bytes to
  // IndexedDB — true for disk opens, also true for recent-list opens so
  // openedAt refreshes (addRecent de-dups on name+size).
  //
  // Buffer ownership caveat: JSZip / PptxGenJS internally transfer the
  // input ArrayBuffer to a worker, which detaches it. Snapshot a copy
  // BEFORE handing the original to the importer so the IDB persist (or
  // any other consumer) gets durable bytes.
  async function importBuffer(buffer: ArrayBuffer, name: string, persist: boolean) {
    setError(null);
    setStatus(null);
    setOpening(true);
    const persistCopy = persist ? buffer.slice(0) : null;
    try {
      const imported = await getPptxClient().import(buffer, name);
      const pageCount = imported.body?.pageOrder.length ?? 0;
      setSnapshot(imported);
      const w = window as unknown as { __pptxImportedSnapshot?: unknown };
      w.__pptxImportedSnapshot = imported;
      if (persistCopy) {
        // Persist BEFORE the status pill flips to "Loaded" — that's the
        // signal e2e (and callers) use to know the deck is ready,
        // including its recent-files entry. IDB writes are sub-ms for
        // small decks; quota/private-mode failures get swallowed since
        // the import itself already succeeded.
        try {
          await addRecent(name, persistCopy);
        } catch {
          /* swallow — failure is "won't show in recent", not data loss */
        }
      }
      setStatus(`Loaded · ${pageCount} slide${pageCount === 1 ? '' : 's'}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  }

  async function handleOpenPptx(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const buffer = await file.arrayBuffer();
    await importBuffer(buffer, file.name, /* persist */ true);
  }

  async function handleOpenRecent(buffer: ArrayBuffer, name: string) {
    // Re-store via importBuffer's persist=true so the entry's openedAt
    // refreshes (de-dup on name+size means we don't duplicate the row).
    await importBuffer(buffer, name, /* persist */ true);
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
        onOpenProperties={() => setPropertiesOpen(true)}
        onOpenRecent={() => setRecentOpen(true)}
        saving={saving}
        opening={opening}
        status={status}
        error={error}
        collabStatus={collab.status}
        collabRoomId={collab.roomId}
        collabPeers={collab.peers}
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
      <PropertiesDialog
        open={propertiesOpen}
        onClose={() => setPropertiesOpen(false)}
        fallback={snapshot}
      />
      <RecentFilesDialog
        open={recentOpen}
        onClose={() => setRecentOpen(false)}
        onOpen={(bytes, name) => {
          void handleOpenRecent(bytes, name);
        }}
      />
      <SlideContextMenu />
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
