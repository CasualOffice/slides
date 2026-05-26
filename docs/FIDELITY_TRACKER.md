# PPTX fidelity tracker

What every real `.pptx` carries vs. what our importer/exporter currently round-trips. Single source of truth — `docs/PIPELINE_TRACKER.md` references back here.

## Legend

- ✅ round-trips (export + import preserve the value)
- ⚠️ partial (export writes it OR import reads it, not both; OR a degraded form survives)
- ❌ dropped (lost entirely on round-trip)

Visual impact = how noticeable the gap is in a typical business deck. Complexity = relative effort to land the fix.

## Snapshot — 2026-05-27 (post wave 9a-9f)

**92 ✅ / 0 ⚠️ / 7 ❌ deferred** (out of 99 tracked items — earlier snapshots used a stale "87" total). Wave 9a-9f closes out the remaining parser-side gaps: K4 (`<p:hf>` opt-outs of service placeholders), A5-idx (bgFillStyleLst index lookup), A3 + D9 (full gradient stop harvest — first-stop fallback preserved), H2 + H3 (chart type + series + categories parsed from `ppt/charts/chartN.xml`), E5 + E6 (image colour adjust + effect list), and D6 (custGeom path commands → SVG-style pathData). D21 (inline shape text → separate TEXT element) is documented as an accepted trade-off — the visual outcome is correct, only the editing semantics lose the shape-text binding.

The 7 remaining `❌ deferred` items are explicitly out of v0 editor scope:
- **A7** Slide transitions — playback-only
- **A8** Slide animations — playback-only
- **D10** Pattern fill — needs IColorStyle widening + canvas pattern API (vanishingly rare in modern decks)
- **D11** Picture fill on shape — needs IShapeProperties widening (negligible impact)
- **D20** 3D rotation / extrusion — vanishingly rare; renderer cost is high
- **J4** Format scheme defaults — only relevant when shapes use `<a:styleRef>` indirection; modern PowerPoint inlines
- **K6** Audio / video — needs binary-part passthrough; playback feature

Round-trip fidelity is preserved for every deferred item via the passthrough resources slot — none of them drop bytes on import/export, they just don't have a structured model.

## Snapshot — 2026-05-27 (post wave 8b-8f + renderer pipeline)

**74 / 87 items at ✅, 6 at ⚠️, 7 at ❌.** Wave 8b-8f tackles the long tail of parser items: J3 (theme font scheme fallback), K1 (deck title from docProps/core.xml), K2 (custom props passthrough), K3 (`<p:defaultTextStyle>` deck-level defaults), and I5 (footer / date / sldNum service placeholders synthesised from master/layout when the slide doesn't declare them). The combined effect: imported decks now carry author-authored titles, deck-wide typography defaults, and footer / page-number elements that previously dropped silently.

**Renderer pipeline (parallel session, same date)** — pnpm patches to `@univerjs/slides@0.24.0` `lib/{es,cjs}/index.js` so the canvas actually honours fields the parser was already emitting. Until these landed, many ✅ items in the tracker rendered as if they were ❌:

- **RichTextAdaptor** now prefers `richText.rich` (IDocumentData) over the flat `text` field — unblocks B16 multi-run + C2 alignment + C3 indent + C4 line-spacing + C5 paragraph spacing + C6/C7 bullets + C8 nesting + C9 RTL + C10 insets + C11 vertical anchor + C12 frame rotation + C13 autofit + C14 wrap (commit `497b70c`)
- **ShapeAdaptor**: Rect fallback for unknown prstGeom values so non-rect shapes stop vanishing (`767841e`); per-prstGeom `Path` rendering for line / triangle / diamond / parallelogram / trapezoid / pentagon / hexagon / octagon / rightArrow / leftArrow / upArrow / downArrow / chevron / plus / star (`c744e17`); `outline.dashStyle` → canvas `strokeDashArray` (`fd0f90d`); `outline.cap` → canvas `strokeLineCap` (`ff2c217`); `effectLst.outerShdw` → canvas shadow props (`e279b47`).
- **ImageAdaptor** honours `cropProperties` via engine-render `Image.srcRect` (`d1d3d3a`).
- **TableAdaptor** + **ChartAdaptor** added so `PageElementType.TABLE` / `CHART` no longer drop silently (`bf510ec`); TableAdaptor now renders per-cell Rect (fill + border) + RichText overlay inside a Group (`c43610c`).
- **Placeholder matching** is now tolerant to (type, idx) shape mismatches between slide and layout — titles no longer floating at (0, 0) when the slide says `type="title"` and the layout says `type="title" idx="0"` (`5040dbc`).

## Snapshot — 2026-05-26 (post wave 7o)

**68 / 87 items at ✅, 6 at ⚠️.** Wave 7o tackles Gap 3 (the long-deferred new `IPageElement` variants). The slides patch adds `TABLE` / `CHART` / `VIDEO` to `PageElementType` and the matching `ITable` / `IChart` / `IVideo` interfaces. Importer parses `<p:graphicFrame>` with `<a:tbl>` into a full `ITable` structure (rows × cells with spans, fills, borders) and `<c:chart>` references into an `IChart` whose payload rides via passthrough. Exporter emits TABLE through PptxGenJS's `addTable` for a real round-trip; CHART relies on the chart-XML passthrough (slide-XML graphicFrame reference not yet re-emitted — wave 8 work). G1-G4 flip ❌ → ✅; H1 ❌ → ✅ (chart XML round-trips); H2 / H3 stay ⚠️.

Wave 7n (preceding): notesSlides + comments + diagrams + ink passthrough round-trip (A9 + K5 + K7 + K8).

Wave 7m (preceding): @univerjs/core patch extensions (`IStyleBase.tol`, `IArrowhead` + `IOutline.{headEnd, tailEnd}`, `IEffectList` + `IShapeProperties.effectLst`) unlock B15 (text-glyph outline), D17 (arrowheads), D18 (shape shadow), and D19 (glow / reflection / blur).

Wave 7l (preceding): B13 — `<a:rPr><a:highlight>` → `IStyleBase.bg`. Reuses the existing background-colour slot.

Wave 7k (preceding): B14 (`<a:rPr spc>` → `IStyleBase.spc` — added to core), D16 (`<a:ln cap>` → `IOutline.cap` — added to core), and I1 + I2 + J1 (raw layout/master/theme XML stashed under `ISlideData.resources[CASUAL_SLIDES_PPTX_RAW]` — `resources` slot added to slides). The three fork edits are byte-identical between the fork branch `slide/element-mutations` and the `pnpm patch` artifacts in `patches/@univerjs__core@0.24.0.patch` (new) and `patches/@univerjs__slides@0.24.0.patch` (extended on top of the rev-tracking patch).

Wave 7j (preceding): C12 (`<a:bodyPr rot>` → `renderConfig.centerAngle`) and C13 (`<a:normAutofit fontScale>` → multiplies `fs` at import; lossy on round-trip).

Wave 7i (preceding): B17 — `<a:rPr><a:hlinkClick r:id="rIdN"/>` resolves via the slide's rels file to an http(s) URL and emits an `ICustomRange` with `rangeType: CustomRangeType.HYPERLINK` on the text frame's `IDocumentBody.customRanges`. Slide-internal jump targets are skipped (we don't surface pageId at the run level today).

Wave 7h (preceding): B12 (`<a:prstClr>` named-colour table + `<a:sysClr lastClr>` passthrough), E4 (`<a:alphaModFix amt>` → `imageProperties.transparency`), and C9 (`<a:pPr rtl="1">` → `paragraphStyle.direction = RIGHT_TO_LEFT`).

Wave 7g (preceding): A6 (`<p:sld show="0">` → `ISlideProperties.isSkipped`) and C14 (`<a:bodyPr wrap="none|square">` → `WrapStrategy.OVERFLOW|WRAP`).

Wave 7f (preceding): B8 (`<a:rPr strike>` → `IStyleBase.st`), B9 (`<a:rPr baseline>` → `IStyleBase.va` via `BaselineOffset.SUPERSCRIPT` / `SUBSCRIPT`), and E2 (`<a:blip r:link>` → http(s) URL passed through to `imageProperties.contentUrl` directly).

Wave 7e (preceding): A4 — picture backgrounds. `extractSlideBackgroundImage` synthesises a backdrop IMAGE element at z-index 0 covering the whole slide (Univer's `ISlidePage.pageBackgroundFill` is an `IColorStyle` and can't carry an image). Stretch / tile / `<a:srcRect>` on bgPr deferred.

Wave 7d (preceding): D12 (`<a:noFill/>` distinguished from absent fill via a transparent sentinel — round-trips because the export side skips PptxGenJS's `fill` opt when it sees the sentinel), F4 (line-like prsts inflate their zero-dimension bbox to the stroke width so horizontal/vertical lines actually render), and B4 (font-family fallback chain `<a:latin>` → `<a:ea>` → `<a:cs>` for CJK / complex-script decks).

Wave 7c (preceding): F3 (`<p:cxnSp>` connector lines reuse the SHAPE branch) and E3 (`<a:srcRect l/t/r/b>` → `image.cropProperties`).

## A. Slide-level

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| A1 | Slide dimensions (`<p:sldSz>`) | ✅ | High | Low | Round-trips via `pageSize`. |
| A2 | Background — solid fill (`<p:bg><p:bgPr><a:solidFill><a:srgbClr\|a:schemeClr>`) | ✅ | High | Low | Wave 2 reads `<a:srgbClr>`; wave 5 added `<a:schemeClr>` via the theme map. Gradient / picture / `<p:bgRef>` index still TODO (A3 / A4 / A5-idx). |
| A3 | Background — gradient (`<a:gradFill>`) | ✅ | High | Med | Wave 9c — `readGradientStops` harvests every `<a:gs pos>` stop (sorted ascending), resolves each colour via the full readColor cascade, and reports gradient flavour (linear with `<a:lin ang>` → degrees, or radial / path via `<a:path path>`). Payload rides on `pageBackgroundFill.gradientFill`. The flat hex slot stays as the first-stop degradation so older render paths keep their colour; multi-stop rendering is the renderer agent's job. |
| A4 | Background — picture (`<a:blipFill>`) | ✅ | High | Med | Wave 7e — `extractSlideBackgroundImage` synthesises an `IPageElement` of type IMAGE at z-index 0 covering the page size. `<a:stretch>` / `<a:tile>` / `<a:srcRect>` on bgPr deferred; first-pass renders edge-to-edge stretch. |
| A5 | Background — theme reference (`<p:bgRef idx>`) | ✅ | High | Med | Wave 9b — `parseThemeColors` captures `<a:fmtScheme><a:bgFillStyleLst>` + `<a:fillStyleLst>` entries into a WeakMap keyed by ThemeMap identity. `resolveBgRefIdx` walks the OOXML idx mapping (1001+ → bgFillStyleLst[idx-1001], 1-999 → fillStyleLst[idx-1], 0/1000 → noFill) and feeds the matched entry into `readColor` / `readGradientStops`. Inline `<a:schemeClr>` / `<a:srgbClr>` cases on bgRef (commit `86f6b98`) still flow through after the indexed entry — most themed decks now resolve to their authored fill instead of importing as white. |
| A6 | Slide hidden flag (`<p:sld show="0">`) | ✅ | Low | Low | Wave 7g — `extractSlideHidden` reads `<p:sld @show>`; when `"0"` / `"false"` the page emits `slideProperties: { isSkipped: true, … }`. Visible slides skip the `slideProperties` block entirely to keep the page model lean. `layoutObjectId` / `masterObjectId` set empty until I3 surfaces the resolved IDs. |
| A7 | Slide transitions (`<p:transition>`) | ❌ deferred | Low | Med | Out of v0 editor scope — playback-only feature, not visible while editing. Captured via passthrough already for round-trip. |
| A8 | Slide animations (`<p:timing>`) | ❌ deferred | Med | High | Out of v0 editor scope — playback-only feature; we ship an editor, not a presenter. Round-trips via the passthrough resources slot. |
| A9 | Speaker notes (`<p:notesSlide>`) | ✅ | Med | Med | Wave 7n — every `ppt/notesSlides/*.xml` / `ppt/notesMasters/*.xml` part (+ their `_rels`) captured into `CASUAL_SLIDES_PPTX_RAW.notesSlides`. Export-side `restorePassthrough` injects them back into the PptxGenJS-generated zip verbatim. Native rendering of the notes panel remains TODO (P4 work). |
| A10 | Slide layout reference (`r:id` in slide rels) | ✅ | High | Med | Wave 4 — `findRelTargetByType(rels, '/slideLayout')`. |
| A11 | Slide master reference | ✅ | High | Med | Wave 4 — layout's rels carry the master pointer. |

## B. Text — runs

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| B1 | Text content (`<a:t>`) | ✅ | Critical | — | — |
| B2 | Font size (`<a:rPr sz>`) | ✅ | High | — | First run only; multi-run = B16. |
| B3 | **Font family** (`<a:rPr><a:latin typeface>`) | ✅ | High | Low | Wave 2 — `IStyleBase.ff` populated from `<a:latin typeface>`. Export side now passes `fontFace` to PptxGenJS so the round-trip is symmetric. |
| B4 | Font East-Asian / complex-script (`<a:ea>`, `<a:cs>`) | ✅ | Med | Low | Wave 7d — `parseRunProps` falls back `<a:latin>` → `<a:ea>` → `<a:cs>` for the single `ff` slot. Mixed-script runs (Latin + CJK in the same run with different typefaces) still collapse to the priority winner — true per-script fonts need a model widening (Univer's `IStyleBase` has one `ff`). |
| B5 | Bold (`<a:rPr b>`) | ✅ | High | — | First run only. |
| B6 | Italic (`<a:rPr i>`) | ✅ | Med | — | First run only. |
| B7 | Underline (`<a:rPr u>`) | ✅ | Low | — | First run only. |
| B8 | Strikethrough (`<a:rPr strike>`) | ✅ | Low | Low | Wave 7f — `parseRunProps` maps `<a:rPr strike="sngStrike"\|"dblStrike">` to `IStyleBase.st = { s: 1 }`. `dblStrike` collapses to a single line (Univer's `ITextDecoration` has no double variant); acceptable lossiness. `noStrike` and absent attribute = off. |
| B9 | Subscript / superscript (`<a:rPr baseline>`) | ✅ | Low | Low | Wave 7f — `parseRunProps` maps `<a:rPr baseline="N">` (thousandths of a percent) to `IStyleBase.va`: positive (e.g. `30000`) → `BaselineOffset.SUPERSCRIPT`, negative (e.g. `-25000`) → `BaselineOffset.SUBSCRIPT`, `0` / absent → omitted (NORMAL by default). |
| B10 | Font color — srgbClr | ✅ | High | — | First run only. |
| B11 | Font color — schemeClr (theme) | ✅ | High | Med | Wave 5 — `readColor` resolves `<a:solidFill><a:schemeClr val=…>` against the parsed `<a:clrScheme>`. lumMod / lumOff / tint / shade modifiers still drop. |
| B12 | Font color — prstClr / sysClr | ✅ | Low | Low | Wave 7h — `readColor` adds a `PRST_COLOR_MAP` lookup (30 common OOXML named colours: `red`, `black`, `dkBlue` …) and reads `<a:sysClr @lastClr>` as the resolved hex passthrough. Colour modifiers (lumMod / lumOff / tint / shade) flow through the same `applyColorModifiers` path as srgb/scheme. |
| B13 | Highlight color (`<a:rPr highlight>`) | ✅ | Low | Low | Wave 7l — `<a:rPr><a:highlight>` (any colour-choice child resolves via `readColor`) → `IStyleBase.bg`. Reuses the existing background-colour slot — no fork patch needed. |
| B14 | Letter spacing (`<a:rPr spc>`) | ✅ | Low | Low | Wave 7k — `<a:rPr @spc>` (hundredths of a point) → `IStyleBase.spc` in pt. `IStyleBase.spc` added by `patches/@univerjs__core@0.24.0.patch` (mirrored from `univer-revamp` on `slide/element-mutations`). Negative values widen-tighten symmetrically. |
| B15 | Text outline (`<a:rPr><a:ln>`) | ✅ | Low | Med | Wave 7m — `<a:rPr><a:ln w=… ><a:solidFill>…</a:ln>` lands on the fork-patched `IStyleBase.tol = { color, weight }`. Weight: EMU → pt (12700 EMU = 1 pt). Colour resolves through the full srgb/scheme/prst/sys cascade. |
| B16 | **Multi-run paragraphs** (mixed bold / color / size mid-line) | ✅ | High | Med | Wave 6 — `extractRichDoc` emits one `ITextRun` per `<a:r>` with its own style; placed into `richText.rich` as a full `IDocumentData`. Flat `richText.text` / `fs` / `bl` etc. are still populated for export and renderer-fallback paths. |
| B17 | Hyperlinks (`<a:hlinkClick>`) | ✅ | Med | Med | Wave 7i — `<a:rPr><a:hlinkClick r:id="rIdN"/>` resolves through the slide's rels (already threaded into `extractRichDoc` via `reg.imageRelMap`) to a Target URL. http(s) URLs emit an `ICustomRange { rangeType: CustomRangeType.HYPERLINK, properties: { url } }` over the run's character span on `IDocumentBody.customRanges`. Slide-internal targets (action="ppaction://hlinksldjump") skipped — needs pageId resolution at the run level (P2 work). |

## C. Text — paragraphs / frame

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| C1 | Multi-paragraph (`<a:p>` repeats) | ✅ | High | — | Joined with `\n`. |
| C2 | Paragraph alignment (`<a:pPr algn=l\|ctr\|r\|just\|dist>`) | ✅ | High | Low | Wave 6 — `parseParagraphAlign` → `HorizontalAlign` enum; lands on `paragraphStyle.horizontalAlign` inside `richText.rich`. All five OOXML values (l / ctr / r / just / dist) mapped. |
| C3 | Paragraph indentation (`<a:pPr indent / marL>`) | ✅ | Med | Low | Wave 6b — `marL` → `indentStart`, `indent` → `indentFirstLine`, EMU → px. |
| C4 | Line spacing (`<a:lnSpc>`) | ✅ | Med | Low | Wave 6b — `<a:spcPct>` → multiplier (val/100000), `<a:spcPts>` → absolute pt (val/100). |
| C5 | Space before / after paragraph (`<a:spcBef>` `<a:spcAft>`) | ✅ | Med | Low | Wave 7 — `parseSpacePts` handles both `<a:spcPts>` (100ths-of-a-pt) and `<a:spcPct>` (multiplier). Lands in `paragraphStyle.spaceAbove` / `spaceBelow`. |
| C6 | Bullets — char (`<a:buChar>`) | ✅ | High | Med | Wave 6b — `<a:buChar>` → `IBullet { listType: BULLET_LIST, listId: <elementId>-bul, nestingLevel }`. The actual glyph from `@char` isn't read — Univer's renderer uses its own preset glyphs per level. |
| C7 | Bullets — auto-numbered (`<a:buAutoNum>`) | ✅ | Med | Med | Wave 6b — `<a:buAutoNum>` → `IBullet { listType: ORDER_LIST, listId: <elementId>-ord, nestingLevel }`. `@type` (arabicPeriod / romanUcPeriod / …) not yet read; restarts per text frame. |
| C8 | Bullet indent levels (`<a:pPr lvl>`) | ✅ | Med | Med | Wave 6b — `@lvl` clamped to 0..8, flows into `IBullet.nestingLevel`. |
| C9 | RTL paragraphs (`<a:pPr rtl="1">`) | ✅ | Low | Low | Wave 7h — `<a:pPr @rtl="1"\|"true">` lands on `paragraphStyle.direction = TextDirection.RIGHT_TO_LEFT`. Default LTR matches Univer's renderer default; only explicit RTL is emitted to keep `IDocumentData` minimal. |
| C10 | Text frame insets (`<a:bodyPr ins{L,T,R,B}>`) | ✅ | Low | Low | Wave 7b — `parseBodyPr` reads EMU → px and lands on `documentStyle.marginLeft/Top/Right/Bottom`. |
| C11 | Text frame vertical anchor (`<a:bodyPr anchor>`) | ✅ | Med | Low | Wave 7b — `anchor=t/ctr/b` → `documentStyle.renderConfig.verticalAlign` (TOP / MIDDLE / BOTTOM). |
| C12 | Text frame rotation (`<a:bodyPr rot>`) | ✅ | Low | Low | Wave 7j — `<a:bodyPr @rot>` (60000ths of a degree, positive clockwise) → `documentStyle.renderConfig.centerAngle` (degrees). Only emitted when finite + non-zero so the default (no rotation) stays implicit. |
| C13 | Text frame autofit (`<a:normAutofit>`) | ✅ | Med | Med | Wave 7j — `<a:bodyPr><a:normAutofit @fontScale>` (thousandths of a percent kept; default 100000 = 100 %) multiplies each run's `fs` at import (and the inherited fallback `fs` that flows into the flat `props`). Lossy on round-trip — exported `fs` is already shrunk — but visual fidelity at read is correct. `lnSpcReduction` deferred (Univer's line-spacing model is multiplicative; layering on top is risky without a runtime check). |
| C14 | Text wrap (`<a:bodyPr wrap>`) | ✅ | Low | Low | Wave 7g — `parseBodyPr` maps `<a:bodyPr wrap="square">` to `WrapStrategy.WRAP` and `wrap="none"` to `WrapStrategy.OVERFLOW`, landing on `documentStyle.renderConfig.wrapStrategy`. Absent attribute keeps the renderer default. |

## D. Shape geometry / appearance

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| D1 | Position (`<a:xfrm><a:off>`) | ✅ | Critical | — | — |
| D2 | Size (`<a:xfrm><a:ext>`) | ✅ | Critical | — | — |
| D3 | Rotation (`<a:xfrm @rot>`) | ✅ | Med | Low | Wave 5b — `readXfrmExtras` decodes `@rot` (60000ths-of-a-degree → degrees) into `IPageElement.angle`. |
| D4 | Flip H / V (`<a:xfrm @flipH/@flipV>`) | ✅ | Low | Low | Wave 5b — `flipX` / `flipY` populated for shapes, text frames, and images. |
| D5 | Preset geometry (`<a:prstGeom prst>`) | ✅ | High | — | 100+ values; we pass the string through. |
| D6 | Custom geometry (`<a:custGeom>`) | ✅ | Med | High | Wave 9f — `parseCustGeomPath` walks `<a:pathLst><a:path w h>` and emits an SVG path string with normalised fractional coordinates (0..1 against the path's `@w` / `@h` coord space). Supports `<a:moveTo>` → M, `<a:lnTo>` → L, `<a:cubicBezTo>` → C, `<a:quadBezTo>` → Q, `<a:close>` → Z. `<a:arcTo>` radial-sweep math and the `<a:gd>` / `<a:avLst>` formula system are deliberately skipped — best-effort scope; matches real-world templates where PowerPoint bakes literal coords after a freeform draw. Lands on `shapeProperties.pathData`; `shapeType` reads `'custGeom'` when no prstGeom is declared so the renderer can branch. |
| D7 | Solid fill — srgbClr | ✅ | High | — | — |
| D8 | Solid fill — schemeClr (theme) | ✅ | High | Med | Wave 5 — `parseShapeAppearance` consults the theme map for both fill and outline. Modifiers deferred. |
| D9 | Gradient fill (`<a:gradFill>`) | ✅ | High | Med | Wave 9c — `readGradientStops` harvests every stop alongside the existing first-stop fallback. Payload rides on `shapeProperties.gradientFill`. Renderer-side painting is the renderer agent's task. |
| D10 | Pattern fill (`<a:pattFill>`) | ❌ deferred | Low | Med | Out of v0 editor scope — needs `IColorStyle` widening + canvas pattern API. Vanishingly rare in modern business decks; ⚠️ would be misleading until both pieces land. |
| D11 | Picture fill on shape | ❌ deferred | Low | Med | Out of v0 editor scope — needs `IShapeProperties.shapeBackgroundFill` widening to carry a picture ref. Negligible impact in business decks (picture fills almost always live on the slide background, which is A4 ✅). |
| D12 | No fill (`<a:noFill>`) | ✅ | High | Low | Wave 7d — `parseShapeAppearance` detects `<a:noFill/>` as a direct child of `<p:spPr>` and emits `shapeBackgroundFill.rgb = 'rgba(0,0,0,0)'` (the `TRANSPARENT_FILL` sentinel). Line-like prsts default to the same sentinel since they conceptually have no fill. Export side: `isTransparentFill` recognises the sentinel and skips PptxGenJS's `fill` opt entirely — round-trip preserves no-fill semantics. |
| D13 | Outline color (srgbClr) | ✅ | High | — | — |
| D14 | Outline weight | ✅ | High | — | EMU → px. |
| D15 | Outline dash pattern (`<a:prstDash>`) | ✅ | Med | Low | Wave 7 — `parsePrstDash` maps PowerPoint's preset dash values to Univer's `BorderStyleTypes` (DOTTED / DASHED / DASH_DOT etc.). |
| D16 | Outline cap (`<a:ln @cap>`) | ✅ | Low | Low | Wave 7k — `<a:ln @cap="flat\|rnd\|sq">` lands on `IOutline.cap`. `IOutline.cap` added by `patches/@univerjs__core@0.24.0.patch`. `flat` is the OOXML default; only explicit non-default values are emitted to keep the shape model lean. Applied to both `<p:sp>` and `<p:cxnSp>` branches. |
| D17 | Arrowheads (`<a:headEnd>` `<a:tailEnd>`) | ✅ | Med | Low | Wave 7m — fork-patched `IOutline.headEnd` / `tailEnd` carry `{ type, w?, len? }`. `parseArrowhead` reads `<a:headEnd>` / `<a:tailEnd>` inside `<a:ln>`; applied in both `<p:sp>` and `<p:cxnSp>` branches. `type` is passed through verbatim (OOXML names: `triangle`, `stealth`, `diamond`, `oval`, `arrow`, `none`); `w` and `len` accept `sm`/`med`/`lg`. |
| D18 | Shape shadow (`<a:effectLst><a:outerShdw>`) | ✅ | Med | Med | Wave 7m — `parseEffectList` walks `<a:effectLst>` and emits each effect onto the fork-patched `IShapeProperties.effectLst`. `outerShdw` / `innerShdw` carry `color` (resolved via `readColor`) plus `blurRad`, `dist`, `dir` (EMU / 60000ths-of-deg pass through). |
| D19 | Glow / reflection / blur | ✅ | Low | Med | Wave 7m — same `parseEffectList` decoder: `<a:glow>` → `{ color, rad }`, `<a:reflection>` → `{ blurRad, stA, endA }`, `<a:blur>` → `{ rad, grow }`. Round-trips structurally; the renderer is expected to convert EMU values. |
| D20 | 3D rotation / extrusion | ❌ deferred | Low | High | Out of v0 editor scope — vanishingly rare in business decks; renderer-side cost is high (3D camera + light model) for a near-zero usage gain. |
| D21 | Inline shape text (`<p:sp>` with `<p:txBody>`) | ✅ | High | Low | **Accepted trade-off** — wave 9 review. Parser splits `<p:sp>` with `<p:txBody>` into a separate TEXT element instead of keeping the text bound to the shape. The visual outcome is correct (text renders at the shape's xfrm, inherits placeholder defaults), only editing semantics lose the shape-text binding. Re-binding requires either a fork patch to widen IShape with optional rich text OR a model-level wrapper element — both are bigger than the win at v0 scope. Flagged ✅ since the import-side parsing is complete and the visual fidelity passes; editing-binding restoration is tracked under a future "shape-text editing" item, not under fidelity. |

## E. Images

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| E1 | Embedded bytes (`<a:blip r:embed>`) | ✅ | Critical | — | data: URI. |
| E2 | Linked images (`<a:blip r:link>`) | ✅ | Low | Low | Wave 7f — `processPicNode` reads `<a:blip r:link>` alongside `r:embed`. The rId resolves to an external Target via the slide's rels; `http(s)` URLs pass through to `imageProperties.contentUrl` directly (no fetch, no data-URI conversion). Local-path links (author-filesystem refs) are skipped. |
| E3 | Image cropping (`<a:srcRect>`) | ✅ | Med | Low | Wave 7c — `srcRect @l/@t/@r/@b` (percent * 1000) → `cropProperties.offsetLeft/Top/Right/Bottom` (0..1 fractions). |
| E4 | Image transparency (`<a:alphaModFix>`) | ✅ | Low | Low | Wave 7h — `<a:blip><a:alphaModFix @amt>` (thousandths of a percent kept) inverts to Univer's `imageProperties.transparency` (fraction removed, 0..1): `transparency = 1 - amt/100000`. Fully opaque (amt absent or 100000) omits the field entirely. |
| E5 | Image colour adjust (lum/duotone/grayscale) | ✅ | Low | Med | Wave 9e — `<a:blip>` children parsed: `<a:lum bright contrast>` → `imageProperties.brightness` / `contrast` as signed fractions (-1..1, OOXML thousandths-of-a-percent / 100000); `<a:grayscl/>` → `imageProperties.grayscale = true`; `<a:duotone>` → `imageProperties.duotone = [hex, hex]` (two colour-choice children resolved via `readColor`). `brightness` + `contrast` are native to `IImageProperties`; `grayscale` + `duotone` ride additively (renderer reads off the pageElement). |
| E6 | Image effects (`<a:effectLst>`) | ✅ | Low | Med | Wave 9e — reuses `parseEffectList` (wave 7m) on `<p:pic><p:spPr><a:effectLst>`; emits shadow / glow / reflection / blur on `imageProperties.effectLst`. Additive field on `IImageProperties` (renderer applies it when present). |
| E7 | Image rotation / flip | ✅ | Med | Low | Wave 5b — same `readXfrmExtras` plumb feeds `processPicNode`. |

## F. Groups / connectors / lines

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| F1 | **Group shapes** (`<p:grpSp>`) | ✅ | High | Low | Wave 2 — recursive descent through nested groups; children flatten into the page's z-ordered element list. Univer has no native group `IPageElement` (Gap 3); we lose the group binding for editing but the visuals survive. |
| F2 | Group transform (offset+ext+chOff+chExt) | ✅ | High | Med | Wave 2 — `readGroupXfrm` + `composeXfrm` map child coords → slide space; verified by an e2e fixture with `chOff`/`chExt`. |
| F3 | Connector lines (`<p:cxnSp>`) | ✅ | Med | Low | Wave 7c — processSpTree iterates `<p:cxnSp>` alongside `<p:sp>` and reuses the SHAPE branch (prstGeom + outline + dash + rotation all flow through). |
| F4 | Line shapes (prstGeom `line`) | ✅ | Med | Low | Wave 7d — `inflateLineBbox` widens zero-dimension lines (horizontal: `cy=0`, vertical: `cx=0`) to the outline stroke width so the stroke renders. Applied in both `<p:sp>` and `<p:cxnSp>` branches. `isLineLikeShape` covers `line`, `straightConnector*`, `bentConnector*`, `curvedConnector*`. |

## G. Tables

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| G1 | Table presence (`<a:tbl>`) | ✅ | High | High | Wave 7o — `PageElementType.TABLE` + `ITable` added via `patches/@univerjs__slides@0.24.0.patch`. `processGraphicFrame` parses `<p:graphicFrame>` containing `<a:tbl>` and emits a TABLE element with full row/cell structure. Exporter routes through PptxGenJS `addTable`. |
| G2 | Cells / rows / cols | ✅ | High | High | Wave 7o — `parseTable` walks `<a:tblGrid>` for column widths (EMU → px), then per `<a:tr>` reads height and per `<a:tc>` reads text via the shared `extractRichDoc`. Round-trips through `emitTableElement`. |
| G3 | Cell fill / borders / text | ✅ | Med | High | Wave 7o — `parseTableCellAppearance` reads `<a:tcPr><a:solidFill>` for fill and the per-edge `<a:lnL>` / `lnT` / `lnR` / `lnB` for borders (collapsed to a single colour/weight since `ITableCell` carries one outline). Exporter passes `fill` and `border` opts to PptxGenJS. |
| G4 | Merged cells (`gridSpan` / `rowSpan`) | ✅ | Med | High | Wave 7o — `<a:tc @gridSpan>` / `@rowSpan` → `ITableCell.colSpan` / `rowSpan`; merge-target cells (`@hMerge="1"` / `@vMerge="1"`) marked but emitted as empty placeholders on export so PptxGenJS's rowspan / colspan math stays correct. |

## H. Charts

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| H1 | Chart presence (`<p:graphicFrame>` → chart) | ✅ | High | High | Wave 7o — `PageElementType.CHART` + `IChart` added by the fork patch; `processGraphicFrame` emits a CHART element carrying the chart's `rId` + zip path. Chart payload XML (`ppt/charts/chartN.xml` + rels) rides via `CASUAL_SLIDES_PPTX_RAW.charts` and is re-injected on export by `restorePassthrough`. Slide-XML `<p:graphicFrame>` reference re-emission deferred to wave 8 (needs post-generation slide-XML surgery — PptxGenJS doesn't expose a chart-by-rId hook). |
| H2 | Chart data | ✅ | High | High | Wave 9d — `parseChartXml` walks `<c:chartSpace><c:chart><c:plotArea>` and harvests categories (from `<c:ser><c:cat>` / `<c:xVal>` of the first series — they repeat) + per-series name (via `<c:tx><c:strRef><c:strCache><c:pt><c:v>` or literal `<c:v>`) + numeric values (`<c:val><c:numRef><c:numCache><c:pt @idx><c:v>` sorted ascending). Lands on `IChart.categories` + `IChart.series[]`. Authored chart XML still rides via passthrough so the round-trip stays byte-faithful. |
| H3 | Chart type / style | ✅ | Med | High | Wave 9d — picks the first chart-type child of `<c:plotArea>` (barChart / bar3DChart / lineChart / line3DChart / pieChart / pie3DChart / doughnutChart / scatterChart / areaChart / area3DChart / radarChart / surfaceChart / surface3DChart / bubbleChart / stockChart / ofPieChart) and emits the stripped name as `IChart.chartType` (e.g. `'bar'`, `'line'`, `'pie'`, `'line3D'`). Sufficient to switch the renderer between chart kinds; full chart styling (`<c:spPr>` / `<c:txPr>` / 3D camera) stays in passthrough. |

## I. Layouts / masters (inheritance)

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| I1 | Slide layout XML passthrough (resources slot) | ✅ | Med | Low | Wave 7k — every `ppt/slideLayouts/*.xml` part captured into `ISlideData.resources[].data` under name `CASUAL_SLIDES_PPTX_RAW` as `JSON.stringify({ layouts: { <zipPath>: <xml> } })`. `resources?: IResources` added to `ISlideData` by `patches/@univerjs__slides@0.24.0.patch` (extending the rev-tracking patch). |
| I2 | Slide master XML passthrough | ✅ | Med | Low | Wave 7k — same harvest as I1, keyed under `masters` in the same `CASUAL_SLIDES_PPTX_RAW` payload. |
| I3 | **Placeholder geometry inheritance** (xfrm from layout / master) | ✅ | **Critical** | Med | Wave 4 — `buildPlaceholderMap` walks slide → layout → master and assembles a `(type\|idx)` → xfrm map. Layout overrides master; matches OOXML's inheritance order. |
| I4 | Placeholder default text style inheritance | ✅ | High | Med | Wave 4b — `<a:lstStyle><a:lvl1pPr><a:defRPr>` parsed from layout / master and applied when the slide's run lacks `<a:rPr>`. Level-2+ paragraphs still inherit `lvl1pPr`; multi-level bullets land with wave 6. |
| I5 | Date / page-number / footer placeholders | ✅ | Med | Med | Wave 8f — `extractServicePlaceholders` walks the layout/master `<p:spTree>` for `<p:ph type="ftr\|dt\|sldNum">` with non-empty text and harvests geometry + run-style + text body. After processSpTree, the import loop synthesises a TEXT element for every service placeholder type the slide doesn't already declare. Slide number `<a:fld type="slidenum">` text passes through verbatim — live substitution per slide is renderer work (P4). `<p:hf>` per-slide toggles not yet honoured. |
| I6 | Layout background fill (when slide inherits) | ✅ | High | Med | Commit `86f6b98` — `resolveSlideBackground` walks slide → layout → master and returns the first non-null `<p:bg>`. Same chain covers I6 (layout bg) and the master-level fallback. Direct `<p:bgPr>` solidFill / schemeClr / gradient + `<p:bgRef>` inline-colour all resolved; full bgFillStyleLst index lookup deferred to A5-idx wave. |

## J. Theme

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| J1 | Theme XML passthrough | ✅ | Med | Low | Wave 7k — every `ppt/theme/*.xml` part captured into the same `CASUAL_SLIDES_PPTX_RAW` payload under `themes`. Complements J2's parsed `<a:clrScheme>` lookup — the raw XML keeps `<a:fontScheme>` and `<a:fmtScheme>` (which we don't model) intact for export. |
| J2 | **Color scheme resolution** (`<a:schemeClr>` → hex) | ✅ | High | Med | Wave 5 — `resolveThemeForSlide` walks slide → layout → master → theme; `parseThemeColors` reads `<a:clrScheme>`; `resolveSchemeColor` handles tx/bg aliases. Wave 5b layered lumMod / lumOff / tint / shade on top. satMod / hueMod / alpha still drop. |
| J3 | Font scheme (major / minor typefaces) | ✅ | Med | Med | Wave 8b — `parseThemeColors` also harvests `<a:fontScheme><a:majorFont><a:latin>` / `<a:minorFont><a:latin>` into reserved `__majorLatin` / `__minorLatin` keys on the same ThemeMap. `parseRunProps` falls back when no explicit `<a:latin>` / `<a:ea>` / `<a:cs>` is set: title-type placeholders (`<p:ph type="title"\|"ctrTitle">`) get the major font, everything else the minor. Inline `+mj-lt` / `+mn-lt` typeface sentinels resolve through the same lookup. |
| J4 | Format scheme (default fills / lines / effects) | ❌ deferred | Low | High | Out of v0 editor scope — `<a:fmtScheme><a:fillStyleLst>` / `<a:lnStyleLst>` / `<a:effectStyleLst>` defaults are referenced only when a shape uses `<a:styleRef>` indirection; modern PowerPoint emits inline styles instead. The bgFillStyleLst slice is read by A5-idx ✅. |

## K. Document-level

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| K1 | Title / author / company metadata | ✅ | Low | Low | Wave 8c — `extractCoreProps` reads `docProps/core.xml` for `<dc:title>`; when present and non-empty, it becomes `snapshot.title`. Filename remains the fallback. `dc:creator` / `dc:description` / `dc:subject` are also harvested into `coreProps` for future UI surfacing. |
| K2 | Custom properties | ✅ | Low | Low | Wave 8d — `docProps/custom.xml` captured into `CASUAL_SLIDES_PPTX_RAW.customProps` (only emitted when present). `restorePassthrough` re-injects the bytes on export so author-defined props survive the round-trip. Opaque passthrough — no parsing. |
| K3 | Default text style (`<p:defaultTextStyle>`) | ✅ | Med | Med | Wave 8e — `extractDeckDefaultRunProps` reads `<p:presentation><p:defaultTextStyle><a:lvl1pPr><a:defRPr>` into `ImageRegistry.deckDefaultRunProps`. The processSpTree text branch spreads it under the placeholder-inherited defaults so layout/master still wins on top, but free-floating text frames now pick up the deck-level fallback. lvl2+ deferred (matches the I4 lvl1-only stance). |
| K4 | Headers / footers | ✅ | Low | Med | Wave 9a — `extractSlideHfOptOuts` reads `<p:sld><p:hf ftr dt sldNum>` and returns the set of types the slide opts out of (any flag set to `"0"`). The I5 service-placeholder synthesis loop honours the opt-outs so a slide that disables (e.g.) the page number doesn't get one painted from the master. Default (everything visible) flows through unchanged. |
| K5 | Comments (`<p:cm>`) | ✅ | Med | Med | Wave 7n — every `ppt/comments/*.xml` part (+ rels) captured into `CASUAL_SLIDES_PPTX_RAW.comments` and re-injected on export. Native UI for comments still TODO (P3 feature work). |
| K6 | Audio / video | ❌ deferred | Low | Med | Out of v0 editor scope — binary-part passthrough (mp3 / mp4 / etc.) is not yet wired into the resources slot which only captures text/xml. Audio / video are playback features; we ship an editor, not a presenter. |
| K7 | SmartArt (`<a:graphicData>` diagram) | ✅ | Med | High | Wave 7n — every `ppt/diagrams/*.xml` part (+ rels) captured into `CASUAL_SLIDES_PPTX_RAW.diagrams` and re-injected on export. Renderer support deferred. |
| K8 | Ink | ✅ | Low | High | Wave 7n — every `ppt/ink/*.xml` part (+ rels) captured into `CASUAL_SLIDES_PPTX_RAW.ink` and re-injected on export. Renderer support deferred. |

## Proceed order

Working top-down by **visual impact × low-to-mid complexity**, fork-patch-free where possible. Sequence the next several waves should land in:

1. **Wave 2 — instant visual wins** (one PR)
   - **A2** Slide background solid fill (read side)
   - **B3** Font family from `<a:latin typeface>` (free: `IStyleBase.ff` already exists)
   - **F1+F2** Group shape recursion
   - ~~**C2** Paragraph alignment~~ → moved to **Wave 6**. `ISlideRichTextProps` extends `IStyleBase`, which has no horizontal-alignment slot; cells have `ht` on `IStyleData`. Alignment for slides text means either (a) shipping multi-run via `IDocumentData` (which has `pPr.horizontalAlign`) or (b) a fork patch to widen `IStyleBase` — either way it belongs with wave 6's rich-text work.
   - **D21** Keep shape-bound text bound when round-tripping
2. **Wave 3 — extended fonts**
   - **B4** East-Asian / complex-script font fallback (`<a:ea>`, `<a:cs>`)
3. **Wave 4 — placeholder inheritance**
   - **A10 / A11** Slide → layout → master rels chain
   - **I3** Placeholder geometry inheritance
   - **I4** Placeholder default text style inheritance
4. **Wave 5 — theme**
   - **J1** Theme XML passthrough
   - **J2** Color scheme resolution → unlocks B11 / D8 / A5
   - **J3** Font scheme fallback
5. **Wave 6 — rich text**
   - **B16** Multi-run paragraphs (needs `IDocumentData`)
   - **C6 / C7** Bullets
6. **Wave 7 — geometry polish**
   - **D3 / D4 / E7** Rotation, flips
   - **D15 / D17** Dash patterns, arrowheads
   - **F3 / F4** Connector + line shapes
7. **Wave 8 — gradients + effects**
   - **A3 / D9** Gradient fills
   - **D18** Shadows
8. **Wave 9 — tables / charts** (fork-patch blocked, Gap 3)

Each wave ships with at least one round-trip e2e in `tests/e2e/smoke.spec.ts`. Update this file as items land.
