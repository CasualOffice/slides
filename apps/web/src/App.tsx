import { useRef, useState } from 'react';
import type { ISlideData, SlideDataModel } from '@univerjs/slides';
import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { Univer } from '@univerjs/core';

import { UniverSlide } from './UniverSlide';
import { getPptxClient } from './pptx/client';
import { DEFAULT_SLIDE_DATA } from './default-slide';

// Triggers a browser download of a Blob by minting an object URL and clicking
// a synthetic anchor. Object URL is revoked next tick to free memory; the
// browser will have grabbed the bytes by then.
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

// Reads the current snapshot off the live Univer instance — used when the
// user clicks Save .pptx. window.univer is set in UniverSlide for
// spike-era diagnostics.
function getCurrentSnapshot(fallback: ISlideData): ISlideData {
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return fallback;
  const instances = univer.__getInjector().get(IUniverInstanceService);
  const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
  return model?.getSnapshot() ?? fallback;
}

export function App() {
  // The active deck. UniverSlide is keyed on this snapshot's id — when
  // Open .pptx imports a new deck, the state update + key change
  // forces React to unmount + remount UniverSlide, which spins up a
  // fresh Univer instance against the new snapshot. Hot-swap via
  // disposeUnit + createUnit doesn't reliably rebind the canvas to
  // our container; remount does. See UniverSlide.tsx for the
  // tradeoff write-up.
  const [snapshot, setSnapshot] = useState<ISlideData>(DEFAULT_SLIDE_DATA);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleSavePptx() {
    setError(null);
    setStatus(null);
    setSaving(true);
    try {
      const live = getCurrentSnapshot(snapshot);
      const { blob, fileName } = await getPptxClient().export(live);
      downloadBlob(blob, fileName);
      setStatus(`Saved ${fileName} (${(blob.size / 1024).toFixed(1)} KB)`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleOpenPptx(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';  // allow re-picking the same file
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
      setStatus(
        `Loaded ${file.name}: ${pageCount} slides · ${imported.pageSize?.width}×${imported.pageSize?.height}px`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  }

  return (
    <>
      <div className="spike-banner">
        <strong>P0 Spike A/B</strong>
        <span>Univer Slides · pptx round-trip via PptxGenJS + JSZip</span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
          style={{ display: 'none' }}
          onChange={handleOpenPptx}
        />
        <button
          className="spike-button"
          onClick={() => fileInputRef.current?.click()}
          disabled={opening}
        >
          {opening ? 'Opening…' : 'Open .pptx'}
        </button>
        <button className="spike-button" onClick={handleSavePptx} disabled={saving}>
          {saving ? 'Saving…' : 'Save .pptx'}
        </button>
        {status && <span className="spike-status" title={status}>{status}</span>}
        {error && <span className="spike-error" title={error}>⚠ {error}</span>}
      </div>
      <UniverSlide key={snapshot.id} snapshot={snapshot} />
    </>
  );
}
