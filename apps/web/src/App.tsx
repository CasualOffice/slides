import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ISlideData, SlideDataModel } from '@univerjs/slides';
import { ICommandService, IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { Univer } from '@univerjs/core';
import { IRenderManagerService } from '@univerjs/engine-render';

import { UniverSlide } from './UniverSlide';
import { getPptxClient } from './pptx/client';
import { DEFAULT_SLIDE_DATA } from './default-slide';
import { TitleBar } from './shell/TitleBar';
import { Toolbar } from './shell/Toolbar';
import { StatusBar } from './shell/StatusBar';
import { NotesPanel } from './shell/NotesPanel';

// Heavy modally-shown surfaces. Each is gated by an `open`/`slideshowOpen`
// boolean and renders null when closed, so lazy() defers the chunk until
// the first user-driven activation. Drops initial JS by ~500 KB.
const SlideShow        = lazy(() => import('./shell/SlideShow').then((m) => ({ default: m.SlideShow })));
const ThemePicker      = lazy(() => import('./shell/ThemePicker').then((m) => ({ default: m.ThemePicker })));
const PageSetupDialog  = lazy(() => import('./shell/PageSetupDialog').then((m) => ({ default: m.PageSetupDialog })));
const PropertiesDialog = lazy(() => import('./shell/PropertiesDialog').then((m) => ({ default: m.PropertiesDialog })));
const RecentFilesDialog = lazy(() => import('./shell/RecentFilesDialog').then((m) => ({ default: m.RecentFilesDialog })));
const AboutDialog      = lazy(() => import('./shell/AboutDialog').then((m) => ({ default: m.AboutDialog })));
import { BusyOverlay } from './shell/BusyOverlay';
import { UniverBootSplash } from './shell/UniverBootSplash';
import { SlideContextMenu } from './shell/SlideContextMenu';
import { dispatchSlideCommand } from './univer/commands';
import { getSelectedElement } from './shell/selection';
import { useCollabBridge } from './collab/CollabProvider';
import { addRecent } from './storage/recent-files';
import { type AutosaveRecord, clearAutosave, loadAutosave, saveAutosave } from './storage/autosave';
import { AutosaveRestoreBanner } from './shell/AutosaveRestoreBanner';

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

// Resolve the main render scene for the focused slide unit. Returns
// `null` if Univer is not ready — every caller no-ops in that case so
// zoom changes happen lazily once the unit is wired.
function getMainScene() {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return null;
  try {
    const instances = univer.__getInjector().get(IUniverInstanceService);
    const unitId = instances.getCurrentUnitOfType(UniverInstanceType.UNIVER_SLIDE)?.getUnitId();
    if (!unitId) return null;
    const renderManager = univer.__getInjector().get(IRenderManagerService);
    return renderManager.getRenderById(unitId)?.scene ?? null;
  } catch {
    return null;
  }
}

// Apply a percentage zoom (100 == 1.0) to the main slide scene. Done
// outside React because the scene is owned by Univer's render manager,
// not a React tree — same pattern Univer's own wheel-zoom uses
// internally (slides-ui scene.scale call).
function applyZoom(percent: number) {
  const scene = getMainScene();
  if (!scene) return;
  const factor = percent / 100;
  try {
    scene.scale(factor, factor);
  } catch {
    /* scene disposed mid-frame — ignore, next call will retry */
  }
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
  const [aboutOpen, setAboutOpen] = useState(false);
  const [pageSetupOpen, setPageSetupOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Active slide index — driven by Univer's `SlideDataModel.activePage$`.
  // Falls back to 0 until the model is wired (first paint).
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  // Zoom percent (100 == 1.0). Owned here so the View menu, status bar
  // slider, and keyboard shortcuts all read/write the same source of
  // truth. Persisted within the session only.
  const [zoom, setZoom] = useState(100);
  // Slide panel toggle. Default visible because the Univer SlideBar
  // renders by default. Stored locally — DOM toggle is a stopgap until
  // we wire ILeftSidebarService (TODO).
  const [slidePanelVisible, setSlidePanelVisible] = useState(true);
  // Saved-state indicator. Set to true when any slide mutation runs;
  // cleared on a successful Save. Listens to `onMutationExecutedForCollab`
  // — same hook the collab bridge uses, so it fires for every dirty op.
  const [dirty, setDirty] = useState(false);

  // === DRAG-AND-DROP IMPORT ===
  // Tracks whether a file is currently hovered over the workspace so we
  // can paint the drop overlay. Multi-file drop is not supported — we
  // take the first .pptx and ignore the rest (PowerPoint behaviour;
  // matches the file-input flow that already only reads files[0]).
  const [dragActive, setDragActive] = useState(false);

  // === UNIVER BOOT SPLASH ===
  // The canvas takes a few hundred ms (occasionally up to a second) to
  // paint after Univer's plugin lifecycle hits Steady state. Without a
  // splash the user sees the chrome + a stark white rectangle — looks
  // like the app is broken. Latched: once true it never resets. Per-
  // import reloads have their own UI (BusyOverlay); re-showing this
  // splash on UniverSlide remount during an import was overlaying the
  // freshly-mounted canvas and Univer's render pipeline didn't recover
  // when the splash later hid (compare-vs-ground-truth regression).
  const [firstPaintDone, setFirstPaintDone] = useState(false);

  // === AUTOSAVE / CRASH RECOVERY ===
  // On boot, look for an autosaved deck. If present and the user is
  // sitting on the untouched default deck, surface a non-blocking
  // banner offering to restore. The user explicitly accepts or
  // dismisses — we never silently swap their working deck.
  const [autosaveOffer, setAutosaveOffer] = useState<AutosaveRecord | null>(null);
  useEffect(() => {
    void (async () => {
      const record = await loadAutosave();
      if (!record) return;
      // Don't pester the user if they already opened a different deck
      // before the IDB read returned (race on slow disks).
      if (snapshot.id !== DEFAULT_SLIDE_DATA.id) return;
      setAutosaveOffer(record);
    })();
    // Intentionally only on mount — re-checking after every snapshot
    // change would re-surface the banner the user just dismissed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Debounced autosave — kicks in 30 s after the latest mutation while
  // dirty. Cleared on every change so a continuously-editing user
  // doesn't pay the JSON-stringify cost on each keystroke. The save
  // pulls the LIVE Univer snapshot (not the React state mirror) so
  // mid-edit work is what gets persisted.
  useEffect(() => {
    if (!dirty) return;
    const handle = window.setTimeout(() => {
      void saveAutosave(getCurrentSnapshot(snapshot), fileName);
    }, 30_000);
    return () => window.clearTimeout(handle);
  }, [dirty, snapshot, fileName]);

  // beforeunload guard — block the tab close / refresh if the user has
  // unsaved work. Browsers ignore the returnValue text these days and
  // show their own dialog; the empty string is enough to trigger it.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Subscribe to Univer's SlideDataModel.activePage$ once the editor has
  // mounted. Univer wires the unit asynchronously after UniverSlide's
  // useEffect, so we poll for the model on a short interval until we get
  // it, then attach an rxjs subscription. Re-runs on snapshot.id change
  // because the UniverSlide is keyed on that — a new instance means a
  // new model and a new subscription.
  useEffect(() => {
    let disposed = false;
    let unsub: (() => void) | null = null;
    let retryHandle: number | null = null;
    let readyHandle: number | null = null;
    let safetyHandle: number | null = null;
    let mutationDisposer: { dispose?: () => void } | null = null;

    // Safety net for COLD boot only: if Univer never wires (broken
    // plugin, race) we still mark first paint as done after 8 s so the
    // user isn't stranded looking at the splash. We do NOT reset the
    // latch on remount — re-showing the splash over a freshly-mounted
    // canvas wedged Univer's render pipeline (compare-vs-ground-truth
    // canvas-blank regression). BusyOverlay handles per-import loading.
    safetyHandle = window.setTimeout(() => setFirstPaintDone(true), 8_000);

    const wire = () => {
      if (disposed) return;
      const w = window as unknown as { univer?: Univer };
      const univer = w.univer;
      if (!univer) {
        retryHandle = window.setTimeout(wire, 200);
        return;
      }
      try {
        const instances = univer.__getInjector().get(IUniverInstanceService);
        const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
        if (!model) {
          retryHandle = window.setTimeout(wire, 200);
          return;
        }
        // activePage$ emits the full ISlidePage (or null) on every
        // activation. We translate to an index against the live page
        // order so the StatusBar reads "Slide N of M" correctly.
        const seedActive = model.getActivePage();
        if (seedActive) {
          const order = model.getPageOrder() ?? [];
          const idx = order.indexOf(seedActive.id);
          if (idx >= 0) setActiveSlideIndex(idx);
        }
        // Model is reachable — canvas is one paint frame away from
        // visible. The 120 ms buffer lets SlideRenderController finish
        // its centering pass so the splash crossfades onto a real
        // canvas, not a blank one. Latched: subsequent remounts skip
        // this (the setter is idempotent on `true`).
        readyHandle = window.setTimeout(() => {
          if (!disposed) setFirstPaintDone(true);
        }, 120);
        const sub = model.activePage$.subscribe((page) => {
          if (disposed || !page) return;
          const order = model.getPageOrder() ?? [];
          const idx = order.indexOf(page.id);
          if (idx >= 0) setActiveSlideIndex(idx);
        });
        unsub = () => sub.unsubscribe();

        // Mutation watcher — flips the dirty bit on any mutation. Same
        // hook as the collab bridge. Univer Slides currently routes
        // element ops through CommandType.OPERATION (Gap 1.4), so they
        // don't fire `onMutationExecutedForCollab`; we layer a
        // commandExecuted listener with an OPERATION filter for slide.*
        // until the upstream fork-patch lands.
        const cs = univer.__getInjector().get(ICommandService);
        const m1 = cs.onMutationExecutedForCollab(() => {
          if (!disposed) setDirty(true);
        });
        const m2 = cs.onCommandExecuted((info) => {
          if (disposed) return;
          // Filter to slide.* mutations and operations that change
          // doc state. Skip purely UI ops like activate-slide / set-thumb
          // / text-edit-cursor.
          const id = info.id;
          if (!id.startsWith('slide.')) return;
          if (
            id === 'slide.operation.activate-slide' ||
            id === 'slide.operation.set-slide-page-thumb' ||
            id.includes('text-edit')
          ) {
            return;
          }
          setDirty(true);
        });
        mutationDisposer = {
          dispose: () => {
            m1?.dispose?.();
            m2?.dispose?.();
          },
        };
      } catch {
        // Service not ready — retry. Cheap enough that a 200 ms poll
        // never blocks first paint.
        retryHandle = window.setTimeout(wire, 200);
      }
    };
    wire();
    return () => {
      disposed = true;
      if (retryHandle != null) window.clearTimeout(retryHandle);
      if (readyHandle != null) window.clearTimeout(readyHandle);
      if (safetyHandle != null) window.clearTimeout(safetyHandle);
      unsub?.();
      mutationDisposer?.dispose?.();
    };
  }, [snapshot.id]);

  // Re-apply the zoom whenever it changes OR the deck remounts. The
  // SlideRenderController centers + sets scale=1 on each mount, so we
  // must reassert our percent after the canvas is alive.
  useEffect(() => {
    // Wait a couple of frames so the scene exists. ResizeObserver in
    // UniverSlide.tsx fires centering after ~80ms.
    const t = window.setTimeout(() => applyZoom(zoom), 120);
    return () => window.clearTimeout(t);
  }, [zoom, snapshot.id]);

  // In-editor commands (z-order, center on slide, duplicate slide, move
  // slide, delete element …) fire a `cs:status` CustomEvent with the
  // confirmation copy. Pipe it into the same status pill the export /
  // save paths use — that way one auto-dismiss handler covers every
  // transient feedback the editor surfaces.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ message?: string }>).detail;
      if (detail?.message) setStatus(detail.message);
    };
    window.addEventListener('cs:status', handler);
    return () => window.removeEventListener('cs:status', handler);
  }, []);

  // Keep the browser tab title in sync with the active deck so users
  // can tell decks apart across tabs + see at a glance whether the
  // current deck has unsaved changes. PowerPoint / Google Slides both
  // do this; pattern: "{name} {dot} · Casual Slides" when dirty,
  // "{name} · Casual Slides" otherwise.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const dot = dirty ? ' •' : '';
    document.title = `${fileName}${dot} · Casual Slides`;
  }, [fileName, dirty]);

  // Auto-dismiss the status pill after 3.5 s. The pill carries transient
  // confirmations ("Saved · slide-1.png", "Created a copy", "Loaded · 3
  // slides") that the user doesn't need to manually close — Google Slides
  // / Office both fade these out. Errors aren't auto-cleared (different
  // state — see the `error` pill); progress messages ("Rendering N / M…")
  // get overwritten by the next setStatus call before the timer fires.
  useEffect(() => {
    if (!status) return;
    const t = window.setTimeout(() => setStatus(null), 3500);
    return () => window.clearTimeout(t);
  }, [status]);

  // When the FormatPane opens/closes the workspace width changes by
  // 280 px (CSS `transition: margin 200 ms`). We do two things:
  //   1) Apply scene.scale(0.85) on open — the slide visually shrinks
  //      so it fits the smaller workspace; restore prior scale on close.
  //   2) After the scale + the CSS transition settle, scroll the
  //      viewport so the slide centre is at the canvas centre. Univer's
  //      built-in scrollToCenter math `(sceneWidth - canvasWidth) / 2`
  //      is scale-unaware — we replace it with the scale-aware version
  //      `(sceneWidth - canvasWidth / scale) / 2` so a slide rendered
  //      at scale=0.85 lands centred, not 100 px to the left.
  const zoomStateRef = useRef<{ priorZoom: number | null }>({ priorZoom: null });
  useEffect(() => {
    function getRenderUnit() {
      const w = window as unknown as { univer?: Univer };
      const univer = w.univer;
      if (!univer) return null;
      try {
        const instances = univer.__getInjector().get(IUniverInstanceService);
        const unitId = instances.getCurrentUnitOfType(UniverInstanceType.UNIVER_SLIDE)?.getUnitId();
        if (!unitId) return null;
        return univer.__getInjector().get(IRenderManagerService).getRenderById(unitId);
      } catch { return null; }
    }

    function recenter() {
      const renderUnit = getRenderUnit();
      if (!renderUnit) return;
      try {
        renderUnit.engine?.resize();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const scene = (renderUnit as any).scene;
        if (!scene) return;
        const scale = scene.scaleX ?? 1;
        // SLIDE_KEY.VIEW = "__mainView__" — the main viewport for the
        // slide unit. Inline the literal so we don't pull SLIDE_KEY for
        // one constant.
        const viewMain = scene.getViewport?.('__mainView__');
        if (!viewMain) return;
        const sceneW = scene.width;
        const sceneH = scene.height;
        const canvasW = renderUnit.engine?.width ?? 0;
        const canvasH = renderUnit.engine?.height ?? 0;
        // Scale-aware: at scale=0.85, the viewport sees canvasW/scale
        // scene units. For centring, the viewport's left in scene coords
        // is (sceneWidth - canvasW/scale) / 2.
        const left = (sceneW - canvasW / scale) / 2;
        const top = (sceneH - canvasH / scale) / 2;
        const { x, y } = viewMain.transViewportScroll2ScrollValue(left, top);
        viewMain.scrollToBarPos({ x, y });
      } catch { /* render unit gone */ }
    }

    function applyAutoZoom(targetPercent: number) {
      const renderUnit = getRenderUnit();
      if (!renderUnit) return;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const scene = (renderUnit as any).scene;
        const f = targetPercent / 100;
        scene?.scale?.(f, f);
      } catch { /* ignore */ }
    }

    const PANE_FIT_PCT = 85;
    const handler = (e: Event) => {
      const open = (e as CustomEvent<{ open: boolean }>).detail?.open;
      if (open) {
        // Remember the user's prior zoom so we can restore on close.
        if (zoomStateRef.current.priorZoom == null) {
          zoomStateRef.current.priorZoom = zoom;
        }
        // Only zoom DOWN — if the user was at 75% we keep 75%.
        const target = Math.min(zoom, PANE_FIT_PCT);
        applyAutoZoom(target);
        setZoom(target);
      } else {
        const restore = zoomStateRef.current.priorZoom ?? zoom;
        zoomStateRef.current.priorZoom = null;
        applyAutoZoom(restore);
        setZoom(restore);
      }
      // The CSS workspace transition is 200 ms. Fire recenter at
      // 0 / 120 / 260 / 420 ms so the final call lands well after the
      // canvas resize + transition complete.
      recenter();
      window.setTimeout(recenter, 120);
      window.setTimeout(recenter, 260);
      window.setTimeout(recenter, 420);
    };

    window.addEventListener('cs:format-pane', handler);
    return () => window.removeEventListener('cs:format-pane', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.id]);

  // Global keyboard shortcuts. Each guards on the active element NOT being
  // an editable input (text-frame editor inside Univer manages its own
  // shortcuts; we don't want to step on those).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Slide text editor — Univer renders the editor as a canvas inside
      // a positioned div with classes "univer-absolute univer-z-10", and
      // mounts the RichTextEditor child only when state.width > 0. The
      // RichTextEditor renders a Univer doc-engine canvas, so neither
      // the container div nor its inner canvas is a contenteditable —
      // our default inEditable check misses it. Detect by walking the
      // SlideEditorContainer and checking it has a RichTextEditor child.
      // (`state.width > 0` translates to inline width > 0 on the div.)
      const editorOpen = typeof document !== 'undefined' && (() => {
        const div = document.querySelector('div.univer-absolute.univer-z-10') as HTMLElement | null;
        if (!div) return false;
        const w = parseFloat(div.style?.width ?? '0');
        return w > 0 && div.children.length > 0;
      })();
      const inEditable = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      );
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      // Inside a text input, only swallow the "edit-text" shortcuts that
      // the input's native handling should win — undo/redo, plain copy/
      // cut/paste, and 'a' for select-all. App-level Ctrl combos
      // (Ctrl+M new slide, Ctrl+D duplicate element, Ctrl+P print, etc.)
      // should still fire — they were broken whenever the FormatPane
      // auto-focused one of its inputs after a selection change, killing
      // shortcut throughput across the rest of the app.
      const textInputShortcuts = new Set(['z', 'y', 'c', 'x', 'v', 'a']);
      if ((inEditable || editorOpen) && textInputShortcuts.has(k)) return;

      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        void dispatchSlideCommand('univer.command.undo');
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        void dispatchSlideCommand('univer.command.redo');
      } else if (k === 'm') {
        // Ctrl+M → append slide. The slides-ui patch fixes the
        // engine-level double-add (AppendSlideOperation was both
        // dispatching SlideInsertPageMutation AND running
        // SlideRenderController.appendPage which wrote to the model
        // again with a fresh getBlankPage()).
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
        // Ctrl+D — duplicate selected element if one is selected, else
        // duplicate the active slide. Standard Slides/PowerPoint UX.
        // Overrides the browser bookmark shortcut either way.
        e.preventDefault();
        if (getSelectedElement()) {
          void dispatchSlideCommand('casual-slides.command.duplicate-element');
        } else {
          void dispatchSlideCommand('slide.command.duplicate-slide');
        }
      } else if (k === 'c' && getSelectedElement()) {
        // Ctrl+C with an element selected — copy element to in-memory
        // clipboard. When focus is in a text edit (handled by the
        // inEditable guard above), we don't reach here. Letting Ctrl+C
        // pass through otherwise so browser-default copy still works
        // for any selected DOM text outside the canvas.
        e.preventDefault();
        void dispatchSlideCommand('casual-slides.command.copy-element');
      } else if (k === 'x' && getSelectedElement()) {
        // Ctrl+X — cut: copy element to clipboard, then delete it.
        // Sequenced so the clipboard is loaded before the element
        // disappears. Same inEditable guard upstream keeps text-edit
        // cut behaviour untouched.
        e.preventDefault();
        void (async () => {
          await dispatchSlideCommand('casual-slides.command.copy-element');
          await dispatchSlideCommand('casual-slides.command.delete-element');
        })();
      } else if (k === 'v') {
        // Ctrl+V — paste the last-copied element on the active slide.
        // No-op if nothing has been copied. Same inEditable guard above
        // keeps text-editing paste behaviour intact.
        e.preventDefault();
        void dispatchSlideCommand('casual-slides.command.paste-element');
      } else if (k === 'a') {
        // Ctrl+A — select every element on the active slide via the
        // canvas transformer. The textInputShortcuts gate above lets
        // 'a' through to the input's native select-all when focus is in
        // a real form field, so we only reach here on canvas focus.
        e.preventDefault();
        void dispatchSlideCommand('casual-slides.command.select-all-on-page');
      } else if (k === 'k') {
        // Ctrl+K — Insert link. Routed through our wrapper so the
        // docs-hyper-link plugin lazy-inits on first invocation. The
        // plugin itself also registers Ctrl+K once started — that becomes
        // a no-op duplicate after the first dispatch, harmless.
        e.preventDefault();
        void dispatchSlideCommand('casual-slides.command.insert-link');
      } else if (k === ']' && e.shiftKey && !e.altKey) {
        // Ctrl+Shift+] — bring selected element forward by one layer.
        e.preventDefault();
        void dispatchSlideCommand('casual-slides.command.z-order', { direction: 'forward' });
      } else if (k === '[' && e.shiftKey && !e.altKey) {
        // Ctrl+Shift+[ — send selected element back by one layer.
        e.preventDefault();
        void dispatchSlideCommand('casual-slides.command.z-order', { direction: 'backward' });
      } else if (k === ']' && e.altKey) {
        // Ctrl+Alt+] — bring to front.
        e.preventDefault();
        void dispatchSlideCommand('casual-slides.command.z-order', { direction: 'front' });
      } else if (k === '[' && e.altKey) {
        // Ctrl+Alt+[ — send to back.
        e.preventDefault();
        void dispatchSlideCommand('casual-slides.command.z-order', { direction: 'back' });
      } else if (k === '=' || k === '+') {
        e.preventDefault();
        setZoom((z) => Math.min(400, z + 10));
      } else if (k === '-') {
        e.preventDefault();
        setZoom((z) => Math.max(25, z - 10));
      } else if (k === '0' && e.shiftKey) {
        // Ctrl+Shift+0 — fit to window (recenter + reset zoom to 100 %).
        // Mirrors View ▸ Fit to window.
        e.preventDefault();
        handleFitToWindow();
      } else if (e.key === 'ArrowUp' && e.shiftKey) {
        // Ctrl+Shift+↑ — move active slide up. Same swap reorderPage
        // does from the slide-rail context menu, but reachable without
        // mousing.
        e.preventDefault();
        void dispatchSlideCommand('casual-slides.command.move-active-slide', { direction: 'up' });
      } else if (e.key === 'ArrowDown' && e.shiftKey) {
        // Ctrl+Shift+↓ — move active slide down.
        e.preventDefault();
        void dispatchSlideCommand('casual-slides.command.move-active-slide', { direction: 'down' });
      } else if (k === '0') {
        e.preventDefault();
        setZoom(100);
      }
    };
    const deleteSlideHandler = (e: KeyboardEvent) => {
      // Bare Delete / Backspace. Skip if focus is in any editable surface
      // — the text-frame editor uses Delete for character deletion.
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const target = e.target as HTMLElement | null;
      const inEditable = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      );
      if (inEditable) return;
      // Shift+Delete deletes the active slide. Bare Delete deletes the
      // currently-selected SHAPE — Google Slides / PowerPoint UX when a
      // non-text element has focus.
      if (e.shiftKey) {
        e.preventDefault();
        void dispatchSlideCommand('slide.command.delete-slide');
        return;
      }
      const sel = getSelectedElement();
      if (sel) {
        e.preventDefault();
        void dispatchSlideCommand('casual-slides.command.delete-element');
      }
    };
    // Plain arrow keys (no Ctrl/Meta) nudge the selected element by 1px,
    // 10px with Shift. Standard Slides/PowerPoint behaviour. Skip when
    // focus is in any editable surface — text-edit uses arrows to move
    // the caret — and when no element is selected (let the browser
    // handle scrolling).
    const nudgeHandler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'ArrowLeft' && k !== 'ArrowRight') return;
      // Univer's canvas-input proxy is a contentEditable DIV that gets focus
      // whenever the slide canvas is interacted with — even on a single
      // shape selection. The contentEditable flag alone can't distinguish
      // "selected, not editing" from "actively text-editing", so we skip
      // only real form fields (INPUT/TEXTAREA) here. Active text-editing is
      // separately gated by checking that no slide element is selected (the
      // selection bridge clears when a doc edit takes focus).
      const target = e.target as HTMLElement | null;
      const inFormField = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA'
      );
      if (inFormField) return;
      const sel = getSelectedElement();
      if (!sel) return;
      const step = e.shiftKey ? 10 : 1;
      let dx = 0, dy = 0;
      if (k === 'ArrowUp') dy = -step;
      else if (k === 'ArrowDown') dy = step;
      else if (k === 'ArrowLeft') dx = -step;
      else if (k === 'ArrowRight') dx = step;
      e.preventDefault();
      e.stopPropagation();
      void dispatchSlideCommand('casual-slides.command.nudge-element', { dx, dy });
    };
    const f5Handler = (e: KeyboardEvent) => {
      if (e.key === 'F5') {
        e.preventDefault();
        setSlideshowOpen(true);
      }
    };
    // PageUp / PageDown navigate slides in editing mode. The slideshow
    // overlay has its own handler — skip when a dialog is open or focus
    // is in an editable surface so paging inside text edit doesn't jump
    // slides under the user.
    const pageNavHandler = (e: KeyboardEvent) => {
      if (e.key !== 'PageUp' && e.key !== 'PageDown' && e.key !== 'Home' && e.key !== 'End') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (typeof document !== 'undefined' && document.querySelector('[role="dialog"]')) return;
      const w = window as unknown as { univer?: Univer };
      const univer = w.univer;
      if (!univer) return;
      try {
        const instances = univer.__getInjector().get(IUniverInstanceService);
        const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
        if (!model) return;
        const order = model.getPageOrder?.();
        if (!order || order.length === 0) return;
        const activeId = model.getActivePage()?.id;
        const idx = activeId ? order.indexOf(activeId) : 0;
        let nextIdx: number;
        if (e.key === 'Home') nextIdx = 0;
        else if (e.key === 'End') nextIdx = order.length - 1;
        else if (e.key === 'PageDown') nextIdx = idx + 1;
        else nextIdx = idx - 1;
        if (nextIdx < 0 || nextIdx >= order.length || nextIdx === idx) return;
        const nextPage = model.getPage(order[nextIdx]!);
        if (!nextPage) return;
        e.preventDefault();
        model.setActivePage(nextPage);
      } catch { /* model torn down */ }
    };
    // F2 enters filename rename mode (standard Windows / Mac convention).
    // TitleBar listens for the event and flips its filenameEditing flag.
    const f2Handler = (e: KeyboardEvent) => {
      if (e.key !== 'F2') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      // Defer to any open modal — F2 inside the shortcuts/properties/
      // recent/etc. dialog shouldn't kick rename mode in the chrome
      // behind it. Same DOM check Esc handler uses.
      if (typeof document !== 'undefined' && document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('cs:rename-filename'));
    };
    // Esc clears the canvas selection. We skip when a dialog is open
    // (the dialog's own Esc handler closes it first) and when focus is
    // in an editable surface (Univer's text-frame editor uses Esc to
    // exit edit mode — we don't want to step on that). The chained
    // effect is nice: clearing selection hides the FormatPane, which
    // fires the `cs:format-pane` event so App's auto-zoom restores the
    // canvas to the user's prior zoom.
    const escHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      const inEditable = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      );
      if (inEditable) return;
      // Defer to any open modal — its own Esc handler closes it. We DOM-
      // check rather than read React state to avoid stale-closure issues
      // (this effect's deps are empty so it only wires once).
      if (typeof document !== 'undefined' && document.querySelector('[role="dialog"]')) return;
      if (!getSelectedElement()) return;
      e.preventDefault();
      void dispatchSlideCommand('casual-slides.command.clear-selection');
    };
    window.addEventListener('keydown', handler);
    window.addEventListener('keydown', f5Handler);
    window.addEventListener('keydown', f2Handler);
    window.addEventListener('keydown', deleteSlideHandler);
    window.addEventListener('keydown', escHandler);
    // Arrow nudge runs in CAPTURE phase so it wins over Univer's own
    // shortcut service (which binds ArrowKey → SetTextEditArrowOperation
    // and similar) when no doc edit is active.
    window.addEventListener('keydown', nudgeHandler, true);
    window.addEventListener('keydown', pageNavHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('keydown', f5Handler);
      window.removeEventListener('keydown', f2Handler);
      window.removeEventListener('keydown', deleteSlideHandler);
      window.removeEventListener('keydown', escHandler);
      window.removeEventListener('keydown', nudgeHandler, true);
      window.removeEventListener('keydown', pageNavHandler);
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
      // Successful export → clean. Subsequent mutations re-dirty.
      setDirty(false);
      // Authoritative bytes left the browser — the autosave snapshot
      // is no longer the freshest copy of this deck, so retire it.
      void clearAutosave();
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
      // Newly-imported deck is clean by definition.
      setDirty(false);
      // The deck the user just opened replaces whatever crash-recovery
      // record may have been pending. If they want both, they'll save
      // the new one explicitly.
      void clearAutosave();
      setAutosaveOffer(null);
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
    // Filename edits are saved with the next export — mark dirty so the
    // indicator reflects the pending change.
    setDirty(true);
  }

  // Page setup. Univer caches the slide rect at mount, so changing pageSize
  // live doesn't re-fit the slide — we re-key the deck (new snapshot.id)
  // which remounts UniverSlide at the new size, preserving all content. Same
  // remount mechanism the .pptx import uses.
  // Download the current slide as a PNG. Renders the SlideTile offscreen
  // at native size, rasterizes via html-to-image, triggers a download.
  async function handleDownloadPng() {
    const live = getCurrentSnapshot(snapshot);
    const pageSize = {
      width: live.pageSize?.width ?? 960,
      height: live.pageSize?.height ?? 540,
    };
    const order = live.body?.pageOrder ?? [];
    const pages = live.body?.pages ?? {};
    const activeId = order[activeSlideIndex] ?? order[0];
    const page = activeId ? pages[activeId] : undefined;
    if (!page) return;
    setError(null);
    setStatus(null);
    try {
      // Dynamic import — pulls html-to-image + the off-screen SlideTile
      // path off the initial bundle. Cold-start cost on first PNG: ~150 ms
      // network + ~50 ms parse on a warm connection.
      const { downloadSlideAsPng } = await import('./shell/download-slide');
      await downloadSlideAsPng(page, pageSize, fileName, activeSlideIndex + 1);
      setStatus(`Saved · slide ${activeSlideIndex + 1}.png`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Export the entire deck as a single PDF. Renders each slide through
  // the same offscreen SlideTile path as the PNG export so the two outputs
  // stay visually consistent.
  async function handleDownloadPdf() {
    const live = getCurrentSnapshot(snapshot);
    const pageSize = {
      width: live.pageSize?.width ?? 960,
      height: live.pageSize?.height ?? 540,
    };
    const order = live.body?.pageOrder ?? [];
    const pageMap = live.body?.pages ?? {};
    const orderedPages = order.map((id) => pageMap[id]).filter((p) => !!p);
    if (!orderedPages.length) return;
    setError(null);
    setStatus(`Rendering 0 / ${orderedPages.length}…`);
    try {
      // Same dynamic-import deferral as the PNG path — pulls jsPDF +
      // html-to-image off the initial bundle (those two combined are
      // ~250 KB minified, the single biggest non-Univer chunk).
      const { downloadDeckAsPdf } = await import('./shell/download-slide');
      await downloadDeckAsPdf(orderedPages, pageSize, fileName, (done, total) => {
        setStatus(`Rendering ${done} / ${total}…`);
      });
      setStatus(`Saved · ${fileName}.pdf`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function handleSetPageSize(width: number, height: number) {
    const live = getCurrentSnapshot(snapshot);
    setSnapshot({
      ...live,
      id: `${live.id || 'deck'}-${Date.now().toString(36)}`,
      pageSize: { ...live.pageSize, width, height },
    });
    setDirty(true);
  }

  // File → Make a copy. Clones the live deck snapshot under a fresh id +
  // " (copy)" title, then swaps state. UniverSlide is keyed on snapshot.id
  // so React remounts a new Univer instance with the cloned content — the
  // user can then File → Save to write the copy as a new .pptx.
  function handleMakeCopy() {
    const live = getCurrentSnapshot(snapshot);
    const cloned = structuredClone(live);
    cloned.id = `${live.id || 'deck'}-copy-${Date.now().toString(36)}`;
    cloned.title = `${(live.title || 'Untitled deck').trim()} (copy)`;
    setSnapshot(cloned);
    setDirty(true);
    setStatus(`Created a copy · ${cloned.title}`);
  }

  // View → Fit to window. Re-invokes SlideRenderController.scrollToCenter
  // (same engine as UniverSlide.tsx mount-centering), then resets zoom to
  // 100% — the centering math assumes scale=1. Google Slides' Fit behaves
  // identically: it always normalises zoom.
  function handleFitToWindow() {
    setZoom(100);
    const w = window as unknown as { univer?: Univer };
    const univer = w.univer;
    if (!univer) return;
    try {
      const instances = univer.__getInjector().get(IUniverInstanceService);
      const unitId = instances.getCurrentUnitOfType(UniverInstanceType.UNIVER_SLIDE)?.getUnitId();
      if (!unitId) return;
      const renderManager = univer.__getInjector().get(IRenderManagerService);
      const renderUnit = renderManager.getRenderById(unitId);
      renderUnit?.engine?.resize();
      // Dynamic import keeps the SlideRenderController out of the main
      // bundle path — we already pull it for UniverSlide.tsx, so the
      // chunk is warm.
      void import('@univerjs/slides-ui').then(({ SlideRenderController }) => {
        try {
          renderUnit?.with(SlideRenderController)?.scrollToCenter();
        } catch {
          /* controller not ready — silent no-op */
        }
      });
    } catch {
      /* ignore */
    }
  }

  // Slide-panel toggle is a DOM-level display flip on Univer's left
  // sidebar wrapper. Stopgap until we wire ILeftSidebarService —
  // see Gap UX-1.x. Re-evaluates on remount because the sidebar div
  // is recreated when UniverSlide remounts.
  function handleToggleSlidePanel() {
    const next = !slidePanelVisible;
    setSlidePanelVisible(next);
    const node = document.querySelector('[data-u-comp="left-sidebar"]') as HTMLElement | null;
    if (node) node.style.display = next ? '' : 'none';
  }

  // Insert → Shape. Toolbar.tsx owns the shapes popover (we're not
  // allowed to refactor it in this pass). Until the popover exposes a
  // window-hook, the safest behavior is to dispatch the rectangle
  // command directly — that's the same default the slides-ui shape
  // menu picks first. TODO: when Toolbar.tsx adds
  // `__casualSlides_openShapes`, call it here instead so the user gets
  // the picker, not an immediate rectangle insert.
  function handleInsertShape() {
    void dispatchSlideCommand('slide.command.insert-float-shape.rectangle');
  }

  // === DRAG-AND-DROP IMPORT ===
  // Drop a .pptx onto the workspace to open it — same import path as the
  // file picker. We only accept the first file; extension check first,
  // fallback to MIME type. dragLeave fires for child element transitions
  // too, so we anchor on `e.currentTarget` to suppress the false negatives.
  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragActive) setDragActive(true);
  }
  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    // Only flip off when leaving the workspace boundary, not when moving
    // between inner children (relatedTarget is null only on real exit).
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragActive(false);
  }
  async function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const isPptx =
      file.name.toLowerCase().endsWith('.pptx') ||
      file.type ===
        'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    if (isPptx) {
      const buffer = await file.arrayBuffer();
      await importBuffer(buffer, file.name, /* persist */ true);
      return;
    }
    // Drag-drop images insert directly onto the active slide. PowerPoint
    // and Google Slides both accept this — the alternative ("only .pptx
    // files supported") felt actively user-hostile.
    if (file.type?.startsWith('image/')) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await dispatchSlideCommand('casual-slides.command.insert-image-from-file', { file } as any);
      return;
    }
    setError('Drop a .pptx file or an image');
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
        onOpenAbout={() => setAboutOpen(true)}
        onOpenPageSetup={() => setPageSetupOpen(true)}
        onDownloadPng={() => void handleDownloadPng()}
        onDownloadPdf={() => void handleDownloadPdf()}
        onMakeCopy={handleMakeCopy}
        onToggleNotes={() => setNotesVisible((v) => !v)}
        onFitToWindow={handleFitToWindow}
        onZoomIn={() => setZoom((z) => Math.min(400, z + 10))}
        onZoomOut={() => setZoom((z) => Math.max(25, z - 10))}
        onToggleSlidePanel={handleToggleSlidePanel}
        onInsertShape={handleInsertShape}
        onDismissStatus={() => setStatus(null)}
        onDismissError={() => setError(null)}
        saving={saving}
        opening={opening}
        dirty={dirty}
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
      <div
        className="cs-workspace"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={(e) => void handleDrop(e)}
      >
        <UniverSlide key={snapshot.id} snapshot={snapshot} />
        {/* === DRAG-AND-DROP IMPORT === */}
        {dragActive && (
          <div className="cs-workspace__drop-overlay" data-testid="drop-overlay" role="status">
            {/* TODO(i18n): swap to t('workspace.dropPptx') once strings migrate. */}
            <span className="cs-workspace__drop-overlay-text">Drop .pptx to open</span>
          </div>
        )}
        <BusyOverlay opening={opening} saving={saving} />
        <UniverBootSplash visible={!firstPaintDone} />
      </div>
      <NotesPanel visible={notesVisible} onToggle={() => setNotesVisible((v) => !v)} />
      <StatusBar
        slideCount={slideCount}
        activeSlideIndex={activeSlideIndex}
        zoom={zoom}
        onZoomChange={setZoom}
        notesVisible={notesVisible}
        onToggleNotes={() => setNotesVisible((v) => !v)}
      />
      {/* Modally-shown surfaces are lazy chunks; gate on the open
          boolean so the import never fires until first activation.
          Suspense fallback is null — the user clicked a button and the
          chunk loads in <100 ms on a warm cache; spinner UI would
          flash distractingly. */}
      <Suspense fallback={null}>
        {slideshowOpen && (
          <SlideShow snapshot={snapshot} onExit={() => setSlideshowOpen(false)} />
        )}
        {themesOpen && (
          <ThemePicker open={themesOpen} onClose={() => setThemesOpen(false)} />
        )}
        {pageSetupOpen && (
          <PageSetupDialog
            open={pageSetupOpen}
            onClose={() => setPageSetupOpen(false)}
            current={{
              width: snapshot.pageSize?.width ?? 960,
              height: snapshot.pageSize?.height ?? 540,
            }}
            onApply={handleSetPageSize}
          />
        )}
        {propertiesOpen && (
          <PropertiesDialog
            open={propertiesOpen}
            onClose={() => setPropertiesOpen(false)}
            fallback={snapshot}
          />
        )}
        {recentOpen && (
          <RecentFilesDialog
            open={recentOpen}
            onClose={() => setRecentOpen(false)}
            onOpen={(bytes, name) => {
              void handleOpenRecent(bytes, name);
            }}
          />
        )}
        {aboutOpen && (
          <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
        )}
      </Suspense>
      <SlideContextMenu />
      <AutosaveRestoreBanner
        offer={autosaveOffer}
        onRestore={(record) => {
          // UniverSlide is keyed on snapshot.id; the autosaved snapshot
          // typically still carries the default-deck id ('untitled-deck'),
          // identical to the current React state's id. Without a fresh id
          // React skips the remount and the Univer model never receives the
          // restored body — visible as "Restore" click + no change. Mint a
          // session-unique id so the key flips and UniverSlide remounts
          // against the restored snapshot.
          const restored = {
            ...record.snapshot,
            id: `${record.snapshot.id || 'restored'}-restored-${Date.now().toString(36)}`,
          };
          setSnapshot(restored);
          // Restored deck is unsaved — mark dirty so the next Save
          // promotes it to a real .pptx on disk.
          setDirty(true);
          setAutosaveOffer(null);
        }}
        onDismiss={() => {
          void clearAutosave();
          setAutosaveOffer(null);
        }}
      />
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
