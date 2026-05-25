import { useState } from 'react';
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

export function App() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSavePptx() {
    setError(null);
    setSaving(true);
    try {
      // Grab the live snapshot from the Univer instance UniverSlide mounted.
      // window.univer is set in UniverSlide for spike-era diagnostics — this
      // is the same handle window.__slideRevProbe uses.
      const w = window as unknown as { univer?: Univer };
      const univer = w.univer;
      const snapshot = (() => {
        if (!univer) return DEFAULT_SLIDE_DATA;
        const instances = univer.__getInjector().get(IUniverInstanceService);
        const model = instances.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE);
        return model?.getSnapshot() ?? DEFAULT_SLIDE_DATA;
      })();

      const { blob, fileName } = await getPptxClient().export(snapshot);
      downloadBlob(blob, fileName);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="spike-banner">
        <strong>P0 Spike A/B</strong>
        <span>
          Univer Slides bootstrap · fork wired via <code>pnpm overrides</code> → <code>../univer-revamp/</code>
        </span>
        <button className="spike-button" onClick={handleSavePptx} disabled={saving}>
          {saving ? 'Saving…' : 'Save .pptx'}
        </button>
        {error && <span className="spike-error" title={error}>⚠ {error}</span>}
      </div>
      <UniverSlide />
    </>
  );
}
