import { useRef, useState } from 'react';
import { UniverSlide } from './UniverSlide';
import { getPptxClient } from './pptx/client';
import { DEFAULT_SLIDE_DATA } from './default-slide';
import type { SlideDataModel } from '@univerjs/slides';
import { IUniverInstanceService, UniverInstanceType } from '@univerjs/core';
import type { Univer } from '@univerjs/core';

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

function getCurrentSnapshot() {
  // window.univer is set in UniverSlide for spike-era diagnostics.
  const w = window as unknown as { univer?: Univer };
  const univer = w.univer;
  if (!univer) return DEFAULT_SLIDE_DATA;
  const instances = univer.__getInjector().get(IUniverInstanceService);
  const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
  return model?.getSnapshot() ?? DEFAULT_SLIDE_DATA;
}

export function App() {
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
      const snapshot = getCurrentSnapshot();
      const { blob, fileName } = await getPptxClient().export(snapshot);
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
      const snapshot = await getPptxClient().import(buffer, file.name);
      const pageCount = snapshot.body?.pageOrder.length ?? 0;
      // The reload swaps the Univer unit by remounting. Simplest for the
      // spike — the proper path is FUniver.createWorkbook-equivalent.
      const w = window as unknown as { __pptxImportedSnapshot?: unknown };
      w.__pptxImportedSnapshot = snapshot;
      setStatus(
        `Imported ${file.name}: ${pageCount} slides · ${snapshot.pageSize?.width}×${snapshot.pageSize?.height}px · stashed on window.__pptxImportedSnapshot`,
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
        <span>
          Univer Slides · pptx round-trip via PptxGenJS + JSZip
        </span>
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
      <UniverSlide />
    </>
  );
}
