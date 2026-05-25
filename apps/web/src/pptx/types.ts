import type { ISlideData } from '@univerjs/slides';

// Wire contracts for messages between the main thread and the pptx Web Worker.
// Keep this file dependency-light — both ends import from it.

export interface PptxExportRequest {
  type: 'export';
  id: number;
  snapshot: ISlideData;
}

export interface PptxExportResult {
  type: 'export-result';
  id: number;
  blob: Blob;
  fileName: string;
}

export interface PptxImportRequest {
  type: 'import';
  id: number;
  file: ArrayBuffer;
  fileName: string;
}

export interface PptxImportResult {
  type: 'import-result';
  id: number;
  snapshot: ISlideData;
}

export interface PptxErrorResult {
  type: 'error';
  id: number;
  message: string;
}

export type PptxRequest = PptxExportRequest | PptxImportRequest;
export type PptxResult = PptxExportResult | PptxImportResult | PptxErrorResult;
