import type { ISlideData } from '@univerjs/slides';

// pptx import — JSZip + fast-xml-parser → ISlideData.
//
// Stubbed pending an audit corpus. The full pipeline is specified in
// docs/PPTX_PIPELINE.md. The minimal T1-text path is unblocked as soon as we
// have 1-2 representative decks to map against — there's no point writing
// the OOXML mapping in a vacuum.
//
// Plan for the first iteration:
//   1. JSZip.loadAsync(file) → archive
//   2. Parse ppt/presentation.xml → pageSize, slideIdLst
//   3. For each slide-rel'd slideN.xml → parse <p:sp>/<p:txBody> → text element
//   4. Map to ISlideData with one TEXT element per <p:txBody>
//
// Anything we don't recognize stashes the raw XML into
// resources["CASUAL_SLIDES_PPTX_RAW"] so the export side can pass it through.

export async function importPptxToSlides(file: ArrayBuffer, fileName: string): Promise<ISlideData> {
  void file;
  void fileName;
  throw new Error(
    'pptx import not yet implemented — see docs/PPTX_PIPELINE.md and pick an audit corpus before authoring the mapping',
  );
}
