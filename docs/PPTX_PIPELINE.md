# PPTX I/O Pipeline

How we round-trip `.pptx` ↔ `ISlideData`. Parallel to sheet's xlsx pipeline, but harder because there is no ExcelJS equivalent for pptx — we write the importer ourselves.

---

## Why we own this

Univer Pro ships `@univerjs-pro/exchange-client` for pptx — closed-source, paid. The OSS side has nothing.

No JS-native, MIT/Apache, mature pptx importer exists. Options surveyed:

| Library | License | Direction | Maturity | Verdict |
|---|---|---|---|---|
| **PptxGenJS** | MIT | Export only | High | ✅ Use for export |
| python-pptx | MIT | Read + write | High | ❌ Wrong runtime (Python) |
| Aspose.Slides FOSS | MIT | Read + write | Med | ⚠️ Multi-language but no JS |
| pptx-parser (npm) | MIT | Read | Low | ❌ Too thin |
| pptx2html | MIT | Read | Low | ⚠️ HTML target, not JSON |

We write the importer using **JSZip** (MIT) + **fast-xml-parser** (MIT) over the OOXML PresentationML spec, targeting the same `ISlideData` shape Univer Slides expects.

Reference for fidelity: PPTist (AGPL, not usable as code — but its 70–80% fidelity sets a useful benchmark).

---

## OOXML pptx — the wire format

A `.pptx` is a ZIP archive. Key parts we care about:

```
my-deck.pptx (zip)
├─ [Content_Types].xml                     part registry
├─ _rels/.rels                              root relationships
├─ docProps/
│   ├─ app.xml                              app metadata
│   └─ core.xml                             title, author, dates
├─ ppt/
│   ├─ presentation.xml                     deck-level config (slide size, slide ids, masters)
│   ├─ presProps.xml
│   ├─ tableStyles.xml
│   ├─ viewProps.xml
│   ├─ _rels/presentation.xml.rels
│   ├─ slides/
│   │   ├─ slide1.xml                       ← one per slide
│   │   ├─ slide2.xml
│   │   └─ _rels/slide1.xml.rels            ← media + layout refs
│   ├─ slideLayouts/
│   │   ├─ slideLayout1.xml                 ← layouts
│   │   └─ _rels/slideLayout1.xml.rels
│   ├─ slideMasters/
│   │   ├─ slideMaster1.xml                 ← masters
│   │   └─ _rels/slideMaster1.xml.rels
│   ├─ notesSlides/                         ← speaker notes per slide
│   ├─ notesMasters/
│   ├─ theme/
│   │   └─ theme1.xml                       ← color + font scheme
│   ├─ media/
│   │   ├─ image1.png
│   │   └─ video1.mp4
│   ├─ charts/                              ← embedded chart definitions (chartML)
│   ├─ embeddings/                          ← embedded xlsx (chart data source)
│   ├─ diagrams/                            ← SmartArt
│   └─ tags/                                ← per-element tags
```

Reference spec: [OOXML PresentationML overview](http://officeopenxml.com/prSlide.php). ECMA-376 / ISO 29500 is the canonical standard.

---

## Import pipeline

```
.pptx Blob
  │
  ▼
JSZip.loadAsync(blob)                 ─► zip archive
  │
  ▼
Parse [Content_Types].xml             ─► map part type → path
  │
  ▼
Parse ppt/presentation.xml            ─► slide IDs, master IDs, page size
  │
  ▼
For each slide:
  Parse ppt/slides/slideN.xml          ─► shapes, text frames, images, transforms
  Parse ppt/slides/_rels/slideN.xml.rels ─► resolve media + layout refs
  │
  ▼
Parse ppt/slideLayouts/*.xml          ─► layouts referenced by slides
Parse ppt/slideMasters/*.xml          ─► masters referenced by layouts
Parse ppt/theme/theme1.xml            ─► color + font scheme
  │
  ▼
Parse ppt/notesSlides/*.xml           ─► speaker notes per slide
  │
  ▼
For each <p:pic> element with rId:
  Extract media from ppt/media/      ─► blob URL or base64
  │
  ▼
Map to ISlideData:                    ─► canonical Univer snapshot
  {
    id, title, pageSize: { width, height },
    body: { pages, pageOrder },
    master: { ... }, layouts: { ... }, notesMaster: { ... }
  }
  │
  ▼
Stash raw pptx parts not mapped       ─► resources["CASUAL_SLIDES_PPTX_RAW"]
  (animations, transitions, SmartArt, comments, custom XML)
```

### The OOXML → `ISlideData` mapping table

| OOXML element | `ISlideData` field |
|---|---|
| `<p:sldSz cx cy>` | `pageSize: { width, height }` (EMU → px, /9525) |
| `<p:sldId>` | entry in `body.pageOrder` |
| `<p:sld>` | `ISlidePage` |
| `<p:sld>/<p:cSld>/<p:bg>` | `ISlidePage.pageBackgroundFill` |
| `<p:sp>` (shape) | `IPageElement { type: SHAPE, shape: { shapeType, shapeProperties } }` |
| `<p:sp>/<p:txBody>` | `IPageElement { type: TEXT, richText: ISlideRichTextProps }` |
| `<p:pic>` | `IPageElement { type: IMAGE, image: { imageProperties } }` |
| `<p:sp>/<p:spPr>/<a:xfrm>` | `IPageElement { left, top, width, height, angle, flipH, flipV }` |
| `<p:cxnSp>` (connector) | `IPageElement { type: LINE, ... }` — needs Gap 3 patch |
| `<p:graphicFrame>` w/ table | `IPageElement { type: TABLE, ... }` — needs Gap 3 patch |
| `<p:graphicFrame>` w/ chart | `IPageElement { type: CHART, ... }` — needs Gap 3 patch |
| `<p:sldLayout>` | entry in `layouts` |
| `<p:sldMaster>` | entry in `master` |
| `<a:clrScheme>` (in theme) | `colorScheme` on pages / `theme.colorScheme` |
| `<p:transition>` | `resources["CASUAL_SLIDES_TRANSITIONS"][pageId]` |
| `<p:timing>` (animations) | `resources["CASUAL_SLIDES_ANIMATIONS"][pageId]` |
| `<p:notes>` | `notesMaster` + per-slide notes page |

### Coordinate system

OOXML uses **EMU** (English Metric Units): 914,400 EMU = 1 inch, 9525 EMU = 1 px @ 96 DPI. Univer uses pixels. Divide by 9525 on import; multiply by 9525 on export.

### Color model

OOXML colors can be `srgbClr`, `schemeClr` (theme reference), `prstClr` (preset name), `hslClr`, with optional alpha + tint + shade. Theme refs resolve via the theme's `clrScheme`. Univer's `IColorStyle` is simpler — needs flattening on import (with the option to keep the theme reference in a side-channel for round-trip fidelity).

### Text — `<p:txBody>` to `richText.rich`

The hardest single sub-problem. `<a:p>` (paragraph) and `<a:r>` (run) map to Univer's `IDocumentData` paragraph/run structure. Properties: font family, size, color, bold, italic, underline, strike, vertical align, alignment, indent, line spacing, bullet list (`<a:buChar>` / `<a:buAutoNum>`), hyperlink.

PPTist's 70-80% target is mostly bounded by text fidelity. Plan: hit common cases in P0/P1; round-trip oddities via `resources["CASUAL_SLIDES_PPTX_RAW"]` passthrough.

---

## Export pipeline

```
ISlideData (from Univer)
  │
  ▼
PptxGenJS deck = new pptxgen()
  │
  ▼
deck.layout = "CUSTOM" with width/height from pageSize
  │
  ▼
For each page in pageOrder:
  Create pptxgen slide
  For each IPageElement on page:
    Map ISlideData element → pptxgen API:
      addText({ x, y, w, h, ... })
      addShape(type, { x, y, w, h, fill, line, ... })
      addImage({ data: base64, x, y, w, h })
      addTable(rows, opts)               — Gap 3 dependent
      addChart(type, data, opts)         — Gap 3 dependent
  Add speaker notes if present
  │
  ▼
deck.writeFile() or deck.write({ outputType: 'blob' })
  │
  ▼
Blob → browser download
```

### What PptxGenJS gives us

- Text frames with run-level formatting
- Standard shape types (`rect`, `ellipse`, `roundRect`, `arrow`, `triangle`, `pentagon`, callouts, …)
- Lines / connectors
- Images (base64 or url)
- Tables (cells with formatting)
- Native PowerPoint charts (bar, line, pie, area, scatter, doughnut, radar, bubble)
- Speaker notes
- Slide layouts and masters
- Hyperlinks
- Slide transitions (basic set)

### What PptxGenJS does not give us

- Custom XML passthrough for SmartArt, complex animations, custom shapes
- Embedded video that round-trips (we may need to manually inject `ppt/media/*` and `<p:videoFile>` into the zip post-generation)
- Per-element animations beyond the basics

For these, our strategy is: store raw OOXML XML fragments in `resources["CASUAL_SLIDES_PPTX_RAW"]` on import, and post-process the PptxGenJS-generated zip to inject them back on export. This is the same trick sheet uses for VBA + pivots (`xl/pivotCaches/**` passthrough — see `../sheet/PLAN.md` Phase 6.1).

---

## Worker isolation

All pptx I/O runs in a Web Worker (`apps/web/src/pptx/worker.ts`). Multi-MB decks parse synchronously in JSZip + xml parsing — main-thread parsing freezes UI for hundreds of ms.

Worker message contracts:

```ts
// Import
worker.postMessage({ type: 'import', file: ArrayBuffer });
// → { type: 'import-result', snapshot: ISlideData, resources: { ... } }

// Export
worker.postMessage({ type: 'export', snapshot: ISlideData, resources: { ... } });
// → { type: 'export-result', blob: Blob }
```

---

## Fidelity tiers

Defined for the Phase 0 spike. **Pick representative decks early; don't promise fidelity we can't measure.**

| Tier | What round-trips | Phase |
|---|---|---|
| **T1 — Core** | Slides, text frames, basic shapes, images, transforms, slide order, page size, basic theme colors | P0 spike target |
| **T2 — Layout** | Masters, layouts, layout-derived placeholder text, speaker notes | P1 |
| **T3 — Breadth** | Tables, charts, lines/connectors, hyperlinks, video stubs | P4 |
| **T4 — Advanced** | Animations, transitions, SmartArt | P5 / passthrough |
| **T5 — Edge** | Custom XML extensions, equation editor content, embedded objects | Passthrough only |

Lossiness doc parallel to sheet's `xlsx-lossiness.md` and `ods-lossiness.md` — `pptx-lossiness.md` to be written when we have an audit corpus.

---

## Open questions for Spike B (P0)

1. Pick 5 representative pptx files (audit corpus). Suggested: simple title deck, a marketing deck w/ heavy theming, a deck w/ tables + charts, a deck w/ animations + transitions, a Keynote-exported pptx.
2. Measure T1 fidelity on the audit corpus. Define pass: ≥95% of T1 elements survive round-trip.
3. Validate PptxGenJS handles arbitrary `<p:sldSz>` (not just 16:9 / 4:3 standard sizes) — needed for custom page sizes.
4. Decide post-export zip patching API (do we inject raw XML before PptxGenJS writes, or unzip its output and re-zip?). The latter is simpler but adds 1 zip cycle.
5. Decide on font handling: PptxGenJS embeds nothing — fonts on the rendering machine determine playback. Acceptable for v0.0.x; revisit if customers complain.
