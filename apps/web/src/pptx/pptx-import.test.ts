import JSZip from 'jszip';
import { describe, expect, test } from 'vitest';
import { importPptxToSlides } from './pptx-import';

// Resilience tests for importPptxToSlides — the four user-visible error
// paths (oversize, encrypted, corrupt, missing manifest). The happy
// path is exercised by the Playwright e2e suite (real .pptx fixtures);
// this spec only locks down the friendly error messages so a future
// refactor can't silently regress them.

describe('pptx-import resilience', () => {
  test('rejects files above the 200 MB soft cap', async () => {
    // Buffer doesn't need real PPTX bytes — the size check fires before
    // JSZip ever runs. We allocate the smallest possible "over the line"
    // buffer to keep the test fast.
    const oversize = new ArrayBuffer(200 * 1024 * 1024 + 1);

    await expect(importPptxToSlides(oversize, 'huge.pptx')).rejects.toThrow(
      /too large/i,
    );
    await expect(importPptxToSlides(oversize, 'huge.pptx')).rejects.toThrow(
      /200\.0 MB/,
    );
  });

  test('detects OLE-encrypted (password-protected) pptx via magic bytes', async () => {
    // The OLE compound-file header — same magic real password-protected
    // OOXML uses. The detector should fast-fail with the "decrypt first"
    // message before JSZip throws its less-friendly "not a zip" error.
    const oleHeader = new Uint8Array(64);
    oleHeader.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);

    await expect(
      importPptxToSlides(oleHeader.buffer, 'locked.pptx'),
    ).rejects.toThrow(/password-protected/i);
  });

  test('reports corruption when the bytes are not a valid ZIP', async () => {
    // Garbage bytes JSZip will choke on. The OLE check uses 8 bytes;
    // skip past it so we hit the JSZip parse error.
    const garbage = new Uint8Array(32).fill(0xff);

    await expect(
      importPptxToSlides(garbage.buffer, 'garbage.pptx'),
    ).rejects.toThrow(/corrupt or not a PowerPoint file/);
  });

  test('reports a missing manifest when the zip lacks ppt/presentation.xml', async () => {
    // A real ZIP, valid bytes, but missing the OOXML manifest the
    // PresentationML reader requires. Could be a .docx renamed to .pptx.
    const zip = new JSZip();
    zip.file('docProps/app.xml', '<Properties></Properties>');
    const buf = await zip.generateAsync({ type: 'arraybuffer' });

    await expect(importPptxToSlides(buf, 'wrong-format.pptx')).rejects.toThrow(
      /missing its presentation manifest/,
    );
  });

  test('handles a 0-byte file (empty buffer)', async () => {
    // Realistic user mistake — drop-target trigger on a placeholder file
    // that never finished writing. Size check passes (0 < 200 MB),
    // OLE sniff passes (need 8 bytes), JSZip rejects on empty input.
    const empty = new ArrayBuffer(0);

    await expect(importPptxToSlides(empty, 'empty.pptx')).rejects.toThrow(
      /corrupt or not a PowerPoint file/,
    );
  });

  test('handles a truncated zip (real header but cut off mid-stream)', async () => {
    // Realistic shape — incomplete download. We build a legit pptx-ish
    // zip then chop it in half so the central directory is unreachable.
    // JSZip rejects the truncated archive; the import surfaces the
    // friendly "corrupt or not a PowerPoint file" message.
    const zip = new JSZip();
    zip.file('ppt/presentation.xml', '<p:presentation></p:presentation>');
    zip.file('docProps/app.xml', '<Properties></Properties>');
    const full = await zip.generateAsync({ type: 'arraybuffer' });
    const truncated = full.slice(0, Math.floor(full.byteLength / 2));

    await expect(
      importPptxToSlides(truncated, 'half-download.pptx'),
    ).rejects.toThrow(/corrupt or not a PowerPoint file/);
  });
});
