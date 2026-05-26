# PPTX fidelity tracker

What every real `.pptx` carries vs. what our importer/exporter currently round-trips. Single source of truth — `docs/PIPELINE_TRACKER.md` references back here.

## Legend

- ✅ round-trips (export + import preserve the value)
- ⚠️ partial (export writes it OR import reads it, not both; OR a degraded form survives)
- ❌ dropped (lost entirely on round-trip)

Visual impact = how noticeable the gap is in a typical business deck. Complexity = relative effort to land the fix.

## Snapshot — 2026-05-26 (post wave 7g)

**43 / 87 items at ✅, 5 at ⚠️.** Wave 7g lands two more low-impact items: A6 (`<p:sld show="0">` → `ISlideProperties.isSkipped`) and C14 (`<a:bodyPr wrap="none|square">` → `WrapStrategy.OVERFLOW|WRAP` on `documentStyle.renderConfig`).

Wave 7f (preceding): B8 (`<a:rPr strike>` → `IStyleBase.st`), B9 (`<a:rPr baseline>` → `IStyleBase.va` via `BaselineOffset.SUPERSCRIPT` / `SUBSCRIPT`), and E2 (`<a:blip r:link>` → http(s) URL passed through to `imageProperties.contentUrl` directly).

Wave 7e (preceding): A4 — picture backgrounds. `extractSlideBackgroundImage` synthesises a backdrop IMAGE element at z-index 0 covering the whole slide (Univer's `ISlidePage.pageBackgroundFill` is an `IColorStyle` and can't carry an image). Stretch / tile / `<a:srcRect>` on bgPr deferred.

Wave 7d (preceding): D12 (`<a:noFill/>` distinguished from absent fill via a transparent sentinel — round-trips because the export side skips PptxGenJS's `fill` opt when it sees the sentinel), F4 (line-like prsts inflate their zero-dimension bbox to the stroke width so horizontal/vertical lines actually render), and B4 (font-family fallback chain `<a:latin>` → `<a:ea>` → `<a:cs>` for CJK / complex-script decks).

Wave 7c (preceding): F3 (`<p:cxnSp>` connector lines reuse the SHAPE branch) and E3 (`<a:srcRect l/t/r/b>` → `image.cropProperties`).

## A. Slide-level

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| A1 | Slide dimensions (`<p:sldSz>`) | ✅ | High | Low | Round-trips via `pageSize`. |
| A2 | Background — solid fill (`<p:bg><p:bgPr><a:solidFill><a:srgbClr\|a:schemeClr>`) | ✅ | High | Low | Wave 2 reads `<a:srgbClr>`; wave 5 added `<a:schemeClr>` via the theme map. Gradient / picture / `<p:bgRef>` index still TODO (A3 / A4 / A5-idx). |
| A3 | Background — gradient (`<a:gradFill>`) | ⚠️ | High | Med | Wave 7 — degraded to first colour stop via `readGradFirstStop`. True multi-stop rendering would need to widen `IColorStyle` (fork patch). |
| A4 | Background — picture (`<a:blipFill>`) | ✅ | High | Med | Wave 7e — `extractSlideBackgroundImage` synthesises an `IPageElement` of type IMAGE at z-index 0 covering the page size. `<a:stretch>` / `<a:tile>` / `<a:srcRect>` on bgPr deferred; first-pass renders edge-to-edge stretch. |
| A5 | Background — theme reference (`<p:bgRef idx>`) | ⚠️ | High | Med | `<p:bgPr><a:solidFill><a:schemeClr>` resolves (wave 5); the indexed `<p:bgRef idx>` form (refers into theme.bgFillStyleLst) still TODO. |
| A6 | Slide hidden flag (`<p:sld show="0">`) | ✅ | Low | Low | Wave 7g — `extractSlideHidden` reads `<p:sld @show>`; when `"0"` / `"false"` the page emits `slideProperties: { isSkipped: true, … }`. Visible slides skip the `slideProperties` block entirely to keep the page model lean. `layoutObjectId` / `masterObjectId` set empty until I3 surfaces the resolved IDs. |
| A7 | Slide transitions (`<p:transition>`) | ❌ | Low | Med | Skip for v0; deferred behind playback. |
| A8 | Slide animations (`<p:timing>`) | ❌ | Med | High | Defer. |
| A9 | Speaker notes (`<p:notesSlide>`) | ⚠️ | Med | Med | Stored in `page.description` round-trip via resources passthrough — not an actual notesSlide. |
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
| B12 | Font color — prstClr / sysClr | ❌ | Low | Low | — |
| B13 | Highlight color (`<a:rPr highlight>`) | ❌ | Low | Low | — |
| B14 | Letter spacing (`<a:rPr spc>`) | ❌ | Low | Low | — |
| B15 | Text outline (`<a:rPr><a:ln>`) | ❌ | Low | Med | — |
| B16 | **Multi-run paragraphs** (mixed bold / color / size mid-line) | ✅ | High | Med | Wave 6 — `extractRichDoc` emits one `ITextRun` per `<a:r>` with its own style; placed into `richText.rich` as a full `IDocumentData`. Flat `richText.text` / `fs` / `bl` etc. are still populated for export and renderer-fallback paths. |
| B17 | Hyperlinks (`<a:hlinkClick>`) | ❌ | Med | Med | — |

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
| C9 | RTL paragraphs (`<a:pPr rtl="1">`) | ❌ | Low | Low | — |
| C10 | Text frame insets (`<a:bodyPr ins{L,T,R,B}>`) | ✅ | Low | Low | Wave 7b — `parseBodyPr` reads EMU → px and lands on `documentStyle.marginLeft/Top/Right/Bottom`. |
| C11 | Text frame vertical anchor (`<a:bodyPr anchor>`) | ✅ | Med | Low | Wave 7b — `anchor=t/ctr/b` → `documentStyle.renderConfig.verticalAlign` (TOP / MIDDLE / BOTTOM). |
| C12 | Text frame rotation (`<a:bodyPr rot>`) | ❌ | Low | Low | — |
| C13 | Text frame autofit (`<a:normAutofit>`) | ❌ | Med | Med | — |
| C14 | Text wrap (`<a:bodyPr wrap>`) | ✅ | Low | Low | Wave 7g — `parseBodyPr` maps `<a:bodyPr wrap="square">` to `WrapStrategy.WRAP` and `wrap="none"` to `WrapStrategy.OVERFLOW`, landing on `documentStyle.renderConfig.wrapStrategy`. Absent attribute keeps the renderer default. |

## D. Shape geometry / appearance

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| D1 | Position (`<a:xfrm><a:off>`) | ✅ | Critical | — | — |
| D2 | Size (`<a:xfrm><a:ext>`) | ✅ | Critical | — | — |
| D3 | Rotation (`<a:xfrm @rot>`) | ✅ | Med | Low | Wave 5b — `readXfrmExtras` decodes `@rot` (60000ths-of-a-degree → degrees) into `IPageElement.angle`. |
| D4 | Flip H / V (`<a:xfrm @flipH/@flipV>`) | ✅ | Low | Low | Wave 5b — `flipX` / `flipY` populated for shapes, text frames, and images. |
| D5 | Preset geometry (`<a:prstGeom prst>`) | ✅ | High | — | 100+ values; we pass the string through. |
| D6 | Custom geometry (`<a:custGeom>`) | ❌ | Med | High | Vector paths. |
| D7 | Solid fill — srgbClr | ✅ | High | — | — |
| D8 | Solid fill — schemeClr (theme) | ✅ | High | Med | Wave 5 — `parseShapeAppearance` consults the theme map for both fill and outline. Modifiers deferred. |
| D9 | Gradient fill (`<a:gradFill>`) | ⚠️ | High | Med | Wave 7 — degraded to first colour stop. Brand colour visible; gradient interpolation needs an IColorStyle widening (fork patch). |
| D10 | Pattern fill (`<a:pattFill>`) | ❌ | Low | Med | — |
| D11 | Picture fill on shape | ❌ | Low | Med | — |
| D12 | No fill (`<a:noFill>`) | ✅ | High | Low | Wave 7d — `parseShapeAppearance` detects `<a:noFill/>` as a direct child of `<p:spPr>` and emits `shapeBackgroundFill.rgb = 'rgba(0,0,0,0)'` (the `TRANSPARENT_FILL` sentinel). Line-like prsts default to the same sentinel since they conceptually have no fill. Export side: `isTransparentFill` recognises the sentinel and skips PptxGenJS's `fill` opt entirely — round-trip preserves no-fill semantics. |
| D13 | Outline color (srgbClr) | ✅ | High | — | — |
| D14 | Outline weight | ✅ | High | — | EMU → px. |
| D15 | Outline dash pattern (`<a:prstDash>`) | ✅ | Med | Low | Wave 7 — `parsePrstDash` maps PowerPoint's preset dash values to Univer's `BorderStyleTypes` (DOTTED / DASHED / DASH_DOT etc.). |
| D16 | Outline cap (`<a:ln @cap>`) | ❌ | Low | Low | — |
| D17 | Arrowheads (`<a:headEnd>` `<a:tailEnd>`) | ❌ | Med | Low | — |
| D18 | Shape shadow (`<a:effectLst><a:outerShdw>`) | ❌ | Med | Med | — |
| D19 | Glow / reflection / blur | ❌ | Low | Med | — |
| D20 | 3D rotation / extrusion | ❌ | Low | High | Defer. |
| D21 | Inline shape text (`<p:sp>` with `<p:txBody>`) | ⚠️ | High | Low | We extract the text into a separate TEXT element instead of keeping it bound to the shape — visually OK but loses the shape-text binding for editing. |

## E. Images

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| E1 | Embedded bytes (`<a:blip r:embed>`) | ✅ | Critical | — | data: URI. |
| E2 | Linked images (`<a:blip r:link>`) | ✅ | Low | Low | Wave 7f — `processPicNode` reads `<a:blip r:link>` alongside `r:embed`. The rId resolves to an external Target via the slide's rels; `http(s)` URLs pass through to `imageProperties.contentUrl` directly (no fetch, no data-URI conversion). Local-path links (author-filesystem refs) are skipped. |
| E3 | Image cropping (`<a:srcRect>`) | ✅ | Med | Low | Wave 7c — `srcRect @l/@t/@r/@b` (percent * 1000) → `cropProperties.offsetLeft/Top/Right/Bottom` (0..1 fractions). |
| E4 | Image transparency (`<a:alphaModFix>`) | ❌ | Low | Low | — |
| E5 | Image colour adjust (lum/duotone/grayscale) | ❌ | Low | Med | — |
| E6 | Image effects (`<a:effectLst>`) | ❌ | Low | Med | — |
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
| G1 | Table presence (`<a:tbl>`) | ❌ | High | High | Univer has no native TABLE `IPageElement` — needs fork patch (UNIVER_SLIDES_GAPS.md Gap 3). |
| G2 | Cells / rows / cols | ❌ | High | High | Blocked on G1. |
| G3 | Cell fill / borders / text | ❌ | Med | High | Blocked on G1. |
| G4 | Merged cells (`gridSpan` / `rowSpan`) | ❌ | Med | High | Blocked on G1. |

## H. Charts

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| H1 | Chart presence (`<p:graphicFrame>` → chart) | ❌ | High | High | Blocked on Univer chart `IPageElement` (Gap 3). |
| H2 | Chart data | ❌ | High | High | — |
| H3 | Chart type / style | ❌ | Med | High | — |

## I. Layouts / masters (inheritance)

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| I1 | Slide layout XML passthrough (resources slot) | ❌ | Med | Low | Carry XML across round-trip even if unused. |
| I2 | Slide master XML passthrough | ❌ | Med | Low | — |
| I3 | **Placeholder geometry inheritance** (xfrm from layout / master) | ✅ | **Critical** | Med | Wave 4 — `buildPlaceholderMap` walks slide → layout → master and assembles a `(type\|idx)` → xfrm map. Layout overrides master; matches OOXML's inheritance order. |
| I4 | Placeholder default text style inheritance | ✅ | High | Med | Wave 4b — `<a:lstStyle><a:lvl1pPr><a:defRPr>` parsed from layout / master and applied when the slide's run lacks `<a:rPr>`. Level-2+ paragraphs still inherit `lvl1pPr`; multi-level bullets land with wave 6. |
| I5 | Date / page-number / footer placeholders | ❌ | Med | Med | — |
| I6 | Layout background fill (when slide inherits) | ❌ | High | Med | — |

## J. Theme

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| J1 | Theme XML passthrough | ❌ | Med | Low | Carry across round-trip even if unused. |
| J2 | **Color scheme resolution** (`<a:schemeClr>` → hex) | ✅ | High | Med | Wave 5 — `resolveThemeForSlide` walks slide → layout → master → theme; `parseThemeColors` reads `<a:clrScheme>`; `resolveSchemeColor` handles tx/bg aliases. Wave 5b layered lumMod / lumOff / tint / shade on top. satMod / hueMod / alpha still drop. |
| J3 | Font scheme (major / minor typefaces) | ❌ | Med | Med | Falls back from B3 when `<a:latin>` is absent. |
| J4 | Format scheme (default fills / lines / effects) | ❌ | Low | High | Defer. |

## K. Document-level

| Code | Item | Status | Impact | Complexity | Notes |
|------|------|--------|--------|-----------|-------|
| K1 | Title / author / company metadata | ⚠️ | Low | Low | Set on export (`Casual Slides` author); not read on import. |
| K2 | Custom properties | ❌ | Low | Low | — |
| K3 | Default text style (`<p:defaultTextStyle>`) | ❌ | Med | Med | — |
| K4 | Headers / footers | ❌ | Low | Med | — |
| K5 | Comments (`<p:cm>`) | ❌ | Med | Med | Tracked also as feature work. |
| K6 | Audio / video | ❌ | Low | Med | — |
| K7 | SmartArt (`<a:graphicData>` diagram) | ❌ | Med | High | Renders to image at best. |
| K8 | Ink | ❌ | Low | High | — |

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
