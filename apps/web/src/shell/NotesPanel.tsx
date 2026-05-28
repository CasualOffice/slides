import { useCallback, useEffect, useRef, useState } from 'react';
import type { Univer } from '@univerjs/core';
import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { ISlidePage, SlideDataModel } from '@univerjs/slides';
import { Icon } from './icons';
import { useTranslation } from '../i18n';

// Speaker-notes panel. Renders below the workspace, edits the active
// slide's notes. Stored in ISlidePage.description for now — Univer's
// data model already has the field; the proper move (per Gap 5 — speaker
// notes UI) is to use a `notesSlide` doc-unit per slide, which is what
// the OOXML pptx round-trip uses. The .description path round-trips via
// the resources passthrough in PPTX_PIPELINE.md, so we don't lose data.
//
// Not yet collab-safe — notes edits do not go through a mutation. Path
// forward is `slide.mutation.update-page-notes`; deferred until P2.

interface SnapshotProbe {
  activePageId: string;
  notes: string;
}

function probeSnapshot(): SnapshotProbe | null {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return null;
  try {
    const instances = univer.__getInjector().get(IUniverInstanceService);
    const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
    if (!model) return null;
    const active = model.getActivePage() as ISlidePage | undefined;
    if (!active) return null;
    return { activePageId: active.id, notes: active.description ?? '' };
  } catch {
    return null;
  }
}

function writeNotes(activePageId: string, value: string) {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return;
  try {
    const instances = univer.__getInjector().get(IUniverInstanceService);
    const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
    if (!model) return;
    const page = model.getPage(activePageId);
    if (!page) return;
    page.description = value;
    // Direct write into the in-memory snapshot. Same approach as Univer's
    // own setName(). When P2 collab lands, swap to a mutation so peers see
    // the notes change.
    model.updatePage(activePageId, page);
  } catch {
    /* model not ready */
  }
}

export interface NotesPanelProps {
  visible: boolean;
  onToggle: () => void;
}

export function NotesPanel({ visible, onToggle }: NotesPanelProps) {
  const { t } = useTranslation('notes');
  const [draft, setDraft] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  // Poll the snapshot for active-page changes. Univer exposes activePage$
  // on SlideDataModel but we don't have a clean React-side subscription
  // hook; polling every 200 ms is cheap and keeps the panel decoupled
  // from the UniverSlide remount cycle.
  const sync = useCallback(() => {
    const probe = probeSnapshot();
    if (!probe) return;
    if (probe.activePageId !== activeId) {
      setActiveId(probe.activePageId);
      setDraft(probe.notes);
    }
  }, [activeId]);

  useEffect(() => {
    if (!visible) return;
    sync();
    pollRef.current = window.setInterval(sync, 200);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [visible, sync]);

  // Render the panel even when collapsed so the height transition is
  // smooth — pure-CSS slide on `.cs-notes`. Returning null would snap the
  // status bar up by 140 px and the user sees a jarring jump.
  return (
    <div
      className={`cs-notes ${visible ? 'is-visible' : 'is-hidden'}`}
      role="region"
      aria-label={t('regionLabel')}
      aria-hidden={!visible}
    >
      <div className="cs-notes__header">
        <Icon name="sticky_note_2" size={14} />
        <span className="cs-notes__title">{t('title')}</span>
        <span className="cs-notes__hint">{t('hint')}</span>
        <button
          type="button"
          className="cs-notes__close"
          onClick={onToggle}
          title={t('closeTooltip')}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <textarea
        className="cs-notes__textarea"
        placeholder={activeId ? t('placeholderActive') : t('placeholderEmpty')}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (activeId) writeNotes(activeId, e.target.value);
        }}
        spellCheck
      />
    </div>
  );
}
