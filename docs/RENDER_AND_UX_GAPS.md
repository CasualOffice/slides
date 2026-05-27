# Render + UX gaps tracker

Companion to [`FIDELITY_TRACKER.md`](./FIDELITY_TRACKER.md). The fidelity tracker measures **data preservation** (does OOXML round-trip through the model?). This file tracks the next two axes:

1. **Render fidelity** — does the canvas actually paint what PowerPoint paints? An OOXML field can be ✅ in the data tracker (parser captures it, model carries it, exporter restores it) and still be ⚪ here (adaptor doesn't read it, engine-render doesn't draw it).
2. **UX completeness** — does the editor have the verbs a real presentation tool has?

Last refreshed 2026-05-27 after the render-fidelity + UX audits + D6 fix + wave UX-P0 #3/#4/#6.

---

## Axis 1 — Render fidelity

For every ✅ row in `FIDELITY_TRACKER.md`, the audit traced: parser → model → adaptor → engine-render → canvas. **86 / 99 items visibly render**. The 4 below are the parsed-but-not-painted gaps.

| Tag | Item | Where the chain breaks | Severity | Fix complexity |
|---|---|---|---|---|
| ~~D6~~ | ~~custGeom (custom shapes)~~ | ~~Adaptor ignored `shapeProperties.pathData`; fell through to Rect.~~ **Fixed `71a894e`** — scale-and-pass to engine-render Path. | — | — |
| ~~D17~~ | ~~Arrowheads~~ | ~~Parser wrote outline.headEnd / tailEnd; adaptor dropped them.~~ **Fixed `d578c93`** — line-family prsts append a V-shaped marker (strokes-only) at each endpoint sized by `w`/`len`. Proper filled triangle / stealth / diamond / oval shapes still pending. | — | — |
| ~~C10~~ | ~~Right / bottom body insets~~ | ~~Engine-render RichText patch only read marginLeft / marginTop.~~ **Fixed `13fcbbb`** — shrink docs pageSize.width by lIns + rIns at all three updateDocumentDataPageSize call sites (`_initialProps`, resize handler, `refreshDocumentByDocData`). Bottom inset is implicit via the Infinity-height single-page layout. | — | — |
| **A3 / D9** | **Multi-stop gradient fill** | Parser harvests every `<a:gs>` stop into `gradientFill.stops[]`. Adaptor reads only the first stop (degraded fallback). engine-render has no multi-stop canvas pipe — Rect/Path's `fill` is a single colour string. | 🟠 visible but low-frequency — solid-color shapes are unaffected; only gradient-filled shapes look flat | High — needs canvas gradient API plumbing (Rect/Path need a `fill` that accepts `CanvasGradient`). Larger fork patch with renderer-API widening. |

### Other render observations (not in the 4 critical, but worth noting)

- **B15 text outline** — wired (engine-render strokeText pass per wave 11). Untested against RTL / vertical text / complex shaping. May need follow-up.
- **D18 / D19 effects** — `outerShdw` + `glow` rendered (shared canvas shadow channel). `innerShdw`, `reflection`, `blur` are explicit TODOs in the shape adaptor.
- **H1 charts** — placeholder rect + informative label only. Full chart geometry rendering deferred (multi-week lift).
- **Group transforms F1/F2** — flatten on import. Loses the group binding for editing but the visual outcome is correct.
- **Inline shape text D21** — extracted into a separate TEXT element rather than bound to the shape. Visually correct, loses the shape-text binding for in-place editing.

---

## Axis 2 — UX completeness

Per the UX audit: "Casual Slides is today a *read-only presentation tool* wearing the skin of an editor." Cannot format text, position elements visually, or add images.

### P0 — Critical (a real editor must have)

| # | Gap | Files | Industry anchor |
|---|---|---|---|
| 1 | **No text formatting toolbar** — no B/I/U/S, font family picker, font size, color, highlight. Selection of a text frame shows no contextual controls. | `shell/Toolbar.tsx` (~27-45); needs new selection-aware control row; `App.tsx` needs to subscribe to Univer's selection observable. | PowerPoint ribbon Home tab; Google Slides floating contextual toolbar. |
| 2 | **No alignment / paragraph controls** — no left/center/right/justify, no indent/outdent, no bullet/numbered list toggle. | Same Toolbar location; `univer/commands.ts` already dispatches paragraph mutations. | Format → Align Left/Center/Right; Bullets & Numbering. |
| ~~3~~ | ~~**Shape menu has only rect + ellipse**~~ — **Done** — `SHAPES_MENU` lists 15 prsts; menu items without a slides-ui command dispatch `slide.mutation.insert-element` directly with a hand-crafted IPageElement, leveraging the ShapeAdaptor's per-prstGeom Path branch. Toolbar also got a top-level "Line" shortcut. | `Toolbar.tsx:33-49` (SHAPES_MENU) + `Toolbar.tsx:83-156` (`insertShapeOfType`). | PowerPoint Insert → Shapes (100+ presets); Google Slides Insert → Shape (30+). |
| ~~4~~ | ~~**Image insert disabled**~~ — **Wired** — toolbar Image button now invokes `slide.command.insert-float-image`, which opens the OS file picker via `ILocalFileService` and emits a `SLIDE_INSERT_ELEMENT` mutation. Drop-zone + image-properties panel still pending. | `Toolbar.tsx:58`; `univer-revamp/packages/slides-ui/src/commands/operations/insert-image.operation.ts`. | Insert → Picture / drag-and-drop. |
| 5 | **No selection feedback** — clicking a shape / text frame / image shows no bounding box, no resize handles, no rotation knob. No spatial cue that something is selected. | `UniverSlide.tsx`; needs subscription to engine's selection event + overlay layer for handles. | Universal — 8 resize handles + rotation knob + selection outline. |
| ~~6~~ | ~~**Undo/Redo no disabled state**~~ — **Done** — `useUndoRedoCounts()` polls Univer's injector for `IUndoRedoService` and subscribes to its `undoRedoStatus$` observable; buttons disable when the matching stack hits 0. | `Toolbar.tsx:163-197`. | PowerPoint / Google Slides both grey out exhausted history. |

### P1 — Polish / table-stakes

| # | Gap | Files |
|---|---|---|
| 7 | Line tool disabled in Toolbar | `Toolbar.tsx:36` |
| 8 | Slide-bar drag reorder absent | needs Univer slide-bar widening |
| 9 | Save downloads → no auto-save indicator | `TitleBar.tsx` status pill logic |
| 10 | Zoom slider in StatusBar is visual-only | `StatusBar.tsx:43-68` — `// wiring to Univer's scale API follows in P1` |
| 11 | No search / replace | new dialog + scan textRuns |
| 12 | No speaker-notes badge on thumbnails | `NotesPanel.tsx` + Univer slide-bar |
| 13 | Comments disabled in Toolbar | `Toolbar.tsx:38` |
| 14 | Transitions disabled in Toolbar | `Toolbar.tsx:44` |

### P2 — Roadmap (nice-to-haves)

- Multi-run rich text in SlideShow (mentioned in `SlideShow.tsx:15`)
- Theme customisation (currently 8 fixed themes in `ThemePicker.tsx`)
- Aspect-ratio lock on resize (depends on selection handles first)
- Template gallery on startup (currently DEFAULT_SLIDE_DATA blank deck)
- Keyboard shortcut legend modal (Help menu)

---

## Prioritised next moves

Ranked by impact ÷ complexity. Each row: estimated diff size + scope.

| Order | Item | Why it's first | Estimated scope |
|---|---|---|---|
| ~~1~~ | ~~D6 custGeom~~ | — | **Fixed `71a894e`** |
| ~~2~~ | ~~D17 arrowheads~~ | — | **Fixed `d578c93`** (V-marker; filled-triangle variant TODO) |
| ~~3~~ | ~~C10 right/bottom insets~~ | — | **Fixed `13fcbbb`** |
| ~~4~~ | ~~UX P0 #4 — Image insert~~ | — | **Wired** — `slide.command.insert-float-image` opens file picker via `ILocalFileService`; toolbar button no longer disabled (Toolbar.tsx) |
| ~~5~~ | ~~UX P0 #3 — Line + arrow shape menu items~~ | — | **Done** — `SHAPES_MENU` expanded to 15 prsts (line, 4 arrows, triangle, diamond, polygons, chevron, plus, star); inserted via direct `slide.mutation.insert-element` dispatch with a hand-crafted IPageElement |
| ~~9~~ | ~~UX P0 #6 — Undo/Redo state~~ | — | **Done** — `useUndoRedoCounts()` subscribes to `IUndoRedoService.undoRedoStatus$`; buttons go disabled when respective stack is empty |
| 6 | UX P0 #5 — Selection feedback | The most visually-jarring gap when actually editing | High — selection overlay + handle UI |
| 7 | UX P0 #1 — Text formatting toolbar | Foundation for #2 alignment; requires selection observable | High — new component + selection plumbing |
| 8 | UX P0 #2 — Alignment / paragraph controls | Sits on top of #1 + #5 | Med (~150 LOC, depends on #6) |
| 10 | A3 / D9 multi-stop gradients | Visual depth; lower frequency than arrows / text | High — renderer-API widening |
| 11 | D17 proper filled triangle / stealth / diamond / oval | Replace the V-marker with PowerPoint-shaped arrowheads | Med — Group with fill+stroke paths |

---

## Convention going forward

When marking an item ✅ in `FIDELITY_TRACKER.md`, also check it here:

- **Parsed + Model + Exported**: data fidelity ✅ (the existing tracker is sufficient)
- **+ Renderer reads the field**: visible-by-design — note in the FIDELITY_TRACKER's row
- **+ Manually verified on canvas vs PowerPoint**: full ✅ — gold standard

Items that pass (1) but fail (2) or (3) are called out here with the file:line where the chain breaks.
