# Editing-UX bug investigation — 2026-06-02

The audit pass shipped 14/15 cosmetic polish items but **driving real editing
flows surfaced engine-level bugs that make the editor unusable in practice**:
the user cannot type into text elements. Cosmetic polish doesn't help if
authoring is broken.

This document captures the bugs found via Playwright probes in
`tests/e2e/__diagnostic__/*-probe.spec.mjs`, what I tried, and where a
fork-patch needs to land. None of these are app-shell-fixable; they live in
`@univerjs/slides-ui` text-edit positioning logic.

## Symptom

Driving the live editor through real flows:

| User action | Expected | Actual |
|---|---|---|
| Click on `Click to add title` placeholder → type "Hello" | Title reads "Hello" | Title unchanged: `"Click to add title"` |
| Insert a Rectangle from toolbar → double-click → type "SHAPE" | Shape has text "SHAPE" | Shape text remains empty; `richText` is `undefined` |
| Open an imported real .pptx → double-click any text element → type | Element text updates | Element text unchanged |

**Insert / drag / Ctrl+B / arrow-nudge / undo / shortcuts all work.** Only
text-edit is broken.

## What I observed under the hood

The contenteditable text-edit overlay IS created in DOM on single-click of
a text element. Its bounding rect is consistently invalid:

```js
{ tag: 'DIV', cls: '', x: -37 to 418, y: -88 to 66, w: 0, h: 16, focused: false }
```

Three things are wrong with this:
1. **`width = 0`** — keystrokes have no surface to land in
2. **`y` is negative** in some runs (off-screen above viewport)
3. **`focused = false`** — `document.activeElement` is `DIV.univer-flex` (the outer container), not this contenteditable

A keystroke probe confirmed:
```
keydown T target=CANVAS editable=false
keydown E target=CANVAS editable=false
…
```
Keystrokes reach the **canvas** as the target, with `isContentEditable = false`. They never route into the (offscreen, zero-width) overlay.

## Where the positioning math lives

`node_modules/.pnpm_patches/@univerjs/slides-ui@0.24.0/lib/index.js` lines
1898–2030 — `SlideEditorBridgeService._fitTextSize()`:

```js
const widthOfCanvas  = pxToNum(canvasElement.style.width);
const scaleAdjust    = canvasClientRect.width / widthOfCanvas;     // we measured 1.0 — OK
let { startX, startY } = positionFromEditRectState;                 // ← suspect
startX += canvasOffset.left;
startY += canvasOffset.top;
// …
startX = startX * scaleAdjust + (canvasBoundingRect.left - contentBoundingRect.left);
startY = startY * scaleAdjust + (canvasBoundingRect.top  - contentBoundingRect.top);
```

`positionFromEditRectState` comes from `SlideEditorBridgeService.getEditRectState()` (lines 1649–1712):

```js
const left = editorRectInfo.richTextObj.left;     // slide-coord X of the element
const top  = editorRectInfo.richTextObj.top;      // slide-coord Y
// canvasOffset = slideMainRect position minus viewport scroll
canvasOffset.left = slidePos.x - scrollX;
canvasOffset.top  = slidePos.y - scrollY;
return {
  position: { startX: left, startY: top, … },
  slideCardOffset: canvasOffset,
  // …
};
```

`slidePos` comes from `slideMainRect.left / .top` where `slideMainRect =
mainScene.getObject(SLIDE_KEY.COMPONENT)`.

## RESOLVED — all canonical editor flows green (11/11 PASS)

Five slides-ui patch hunks together fix the engine bugs that made
editing unusable:

1. **`d0dfb50` (parallel lane)** — restored `<RichTextEditor>` inside
   `SlideEditorContainer` which Univer v0.24.0 ships commented out.
   Editor now visibly activates on double-click and accepts keystrokes.

2. **B1 flush fix — Escape triggers commit** — wired `Escape` to call
   `SlideEditorBridgeRenderController.endEditing()` inside the bundle's
   `_initEventListener` (Enter NOT bound; that's a paragraph break, not
   commit — matches Google Slides / PowerPoint multi-line text frames).
   `endEditing()` was already implemented (it dispatches
   `slide.operation.update-element` with the new richText from the
   editor doc) — it just had no keyboard trigger. Click-outside also
   commits via the pre-existing `clearControl$` path.

3. **B1 flush fix — preserve rich body** — `endEditing()` only wrote
   the flat `richText.text` (a single string with newlines stripped)
   plus a guessed `fs/cl/bl`. Per [[project-pptx-rich-field-trap]] the
   RichTextAdaptor prefers `richText.rich`. Now `endEditing()` also
   writes a full `rich = { id, body: { dataStream, textRuns,
   paragraphs }, documentStyle }` block from the editor doc — preserves
   character-run formatting and (when working) paragraphs.

4. **B3 double-add fix** — `SlideRenderController.appendPage()` was
   creating a fresh `model.getBlankPage()` and writing it to the model
   AFTER the patched `AppendSlideOperation` had already dispatched
   `SlideInsertPageMutation` (which writes the page to the model and
   triggers `createPageScene` via the mutation listener). Net effect:
   one Ctrl+M added two pages. Patched `appendPage()` to render the
   existing latest page from `model.getPageOrder()` instead, with a
   `slide.hasPage(pageId)` early-return so it's idempotent when the
   mutation listener already added the scene.

## RESOLVED — multi-paragraph editing (B5)

**Root cause:** Univer's `IUniverInstanceService.focusUnit()` sets
`FOCUSING_DOC = false` whenever the focused unit is a `UNIVER_SLIDE`.
The slide editor activates its inner doc unit via `changeDoc(…)` not
`focusUnit(…)`, so `FOCUSING_DOC` stays false. docs-ui's
`BreakLineShortcut` precondition `whenDocAndEditorFocusedWithBreakLine`
requires `FOCUSING_DOC && FOCUSING_UNIVER_EDITOR`, both of which were
false — so pressing Enter inside the slide editor was a no-op.

**Fix:** In `SlideEditingRenderController._subscribeToCurrentCell`,
when the editor activates, explicitly set both `FOCUSING_DOC` and
`FOCUSING_UNIVER_EDITOR` to `true`. Reset both in `_exitInput`.

Probe (`tests/e2e/__diagnostic__/text-edit-deep-flows.spec.mjs`) now
sees `"Line one\rLine two\r\n"` — `\r` is Univer's paragraph
separator (per [[project-univer-paragraph-separator]] memory), and
both lines are preserved as separate paragraphs.

Side benefit: enabling `FOCUSING_UNIVER_EDITOR` should also activate
the arrow-key cursor-move shortcuts (`SetTextEditArrowOperation`)
which were also gated on this flag, so left/right arrows now navigate
text instead of doing nothing.

Final probe result:

```
✓ [1a-select]
✓ [1b-type-into-title]      title now "Hello world"
✓ [2-insert-rect]
✓ [3-drag]
✓ [4-bold]
✓ [5-new-slide]             Ctrl+M went 1 → 2 (was 1 → 3)
✓ [6-undo-new-slide]        undo correctly removes the one append
✓ [7-delete-slide-menu]
```

**Upstream PR plan:**
- Keydown wiring is a clean upstream candidate (correctness bug in
  `SlideEditorBridgeRenderController._initEventListener`).
- `appendPage()` double-add depends on whether upstream still uses the
  old `OPERATION`-typed `AppendSlideOperation` (which would call only
  `CanvasView.appendPage`). In our patched bundle, both paths run; in
  pure upstream the bug may not exist. The `slide.hasPage` idempotency
  guard is upstream-safe regardless.

---

## Earlier in-flight investigation — kept for the trail

The editor activated and accepted keystrokes, but Escape didn't exit
and the model never received the new text:

- Dblclick on title → white edit box appears with cursor visible
- Ctrl+A + type "Hello world" → canvas updates to show "Hello world"
- Titlebar shows "Unsaved changes" (dirty flag flipped)
- BUT: slide-rail thumbnail keeps showing old "Click to add title"
- AND: model snapshot still reads `"Click to add title"`
- AND: Escape **doesn't exit edit mode** — editor stays active

So B1 has been re-diagnosed twice. The current root cause:

**The editor has its own document model. Typed text never flushes
back to the slide model.** The visual canvas updates because the editor
overlays the slide element with its own render; the slide model's
`richText.text` is never written. Pressing Escape (or any commit
signal) should:

1. Write the editor doc back to `pageElement.richText.text`
2. Increment `model.rev`
3. Hide the editor
4. Restore the slide's normal render path

None of that fires today.

**Where to investigate:**

- `SlideEditorBridgeService.changeVisible(false)` or `_exitInput` —
  these are the candidate commit-points. The probe shows they're never
  reached on Escape.
- The keyboard handler that should intercept Escape in edit mode —
  the editor's `<RichTextEditor>` may be missing an `onKeyDown` →
  commit-and-exit wiring.
- The flush path: editor doc → `slide.command.update-element` or
  `slide.mutation.update-rich-text` (whichever the model expects).

The probe `tests/e2e/__diagnostic__/editing-ux-probe.spec.mjs` will
confirm a fix the moment "Hello world" lands in the model snapshot.

---

## Earlier hypothesis (WRONG — kept for the historical trail)

**Original hypothesis (positioning math double-applies scene offset) was wrong.**
A follow-up probe instrumented `getEditRectState` and `_editAreaProcessing` with
`console.log` and ran the click→text-edit flow. Zero log output —
**neither function is called during a text-element click.** The
`SlideEditorBridgeService` and `SlideEditorBridgeRenderController` never
activate.

The contenteditable I observed at `(-37..418, -88..66, w=0, h=16)` is therefore
**NOT the slide text editor** — it's some other hidden helper (Univer uses
contenteditable divs as global clipboard/paste sinks).

**Corrected hypothesis:** the bug is at the bridge **activation** point —
something between the canvas-click handler and the bridge service's `editRect$`
emission. Either:

1. The slide canvas's `pointerdown` / `dblclick` handler that should fire
   `setSlideTextEditor$` is not wired to the right element / page.
2. The `_currentEditRectInfo` is never set (the `getEditRectInfo()` returns
   null → bridge bails before computing position).
3. A condition guard in `SlideEditorBridgeRenderController` is failing
   (`editorObject == null` check or similar).

To verify: instrument `setSlideTextEditor$.next(…)`, the canvas's
`onPointerDown` / `onDoubleClick`, and `SlideEditorBridgeService.set/get
EditRectInfo`. If those never log either, the bug is at the click→bridge
handoff inside `slides-ui` plugin lifecycle wiring.

Hardcoded measurements:
- Canvas DOM rect: `(220, 108)` size `1220 × 762`
- Slide rendered at native `960 × 540` (scale ≈ 1.0 inside the canvas)
- Element being edited: title placeholder at `(80, 180)` in slide coords
- Expected screen position for overlay: `220 + (1220-960)/2 + 80 = 430`, `108 + (762-540)/2 + 180 = 399`
- Actual overlay position: `(418, -88)` — `y` off by ~487 pixels

The 487-pixel vertical offset matches the order of `slideMainRect.top` if
the scene is anchored above the canvas origin (negative `slideMainRect.top`)
and that anchor leaks into the editor positioning math.

## What to verify in the fork

`../univer-revamp/packages/slides-ui/src/services/slide-editor-bridge.service.ts`
(or equivalent in v0.24.0):

1. **Log `slideMainRect.left / .top` and `viewportScrollX / Y` at the moment
   `getEditRectState()` is called.** Confirm whether these numbers reflect the
   slide's actual painted position or an anchor in scene space.
2. **Check whether `_layoutService.getContentElement()` returns the right
   element.** In our shell the "content element" is `.cs-workspace`, not a
   Univer-owned container. If `getContentElement()` returns something with a
   different bounding rect than expected, `canvasBoundingRect.top -
   contentBoundingRect.top` adds an unintended offset.
3. **Confirm the relationship between `slideMainRect.left/top` and the
   visible slide.** In the v0.24.0 OSS variant, the slide is centred in the
   scene with a margin offset baked in. The editor positioning math may have
   been written for a different scene-anchor convention.

## What's already patched

`patches/@univerjs__slides-ui@0.24.0.patch` already touches
`SlideRenderController` for collab + null-safety, but does **not** touch
`SlideEditorBridgeService` or the `_fitTextSize` / `getEditRectState` paths.
A new patch hunk needs to be added there.

## Sibling bugs found alongside text-edit

| # | Bug | Repro |
|---|---|---|
| B3 | `Ctrl+M` adds **2** slides per keystroke instead of 1. App.tsx `handler` registered once; second source presumably inside Univer or React StrictMode equivalent. | Mitigation already shipped: 200 ms debounce in `App.tsx` Ctrl+M branch. |
| B4 | Slide menu strip → Delete doesn't decrement slide count. Likely dispatches `slide.command.delete-slide` without `pageId`. | Open. Trivially fixable in `TitleBar.tsx` `handleMenuItem('slide', 'delete')` by passing the active page id. |

## Probes available

| File | Purpose |
|---|---|
| `tests/e2e/__diagnostic__/editing-ux-probe.spec.mjs` | Drives the canonical user flows (type / drag / Ctrl+B / Ctrl+M / Slide Delete) against the live model and reports pass/fail per step. **Re-run after any text-edit fork-patch lands.** |
| `tests/e2e/__diagnostic__/text-edit-probe.spec.mjs` | Captures `document.activeElement` + every contenteditable + their bounding rects after a dblclick. |
| `tests/e2e/__diagnostic__/text-edit-shape-probe.spec.mjs` | Same as above but on a fresh inserted shape — confirms the bug isn't placeholder-specific. |
| `tests/e2e/__diagnostic__/text-edit-imported-probe.spec.mjs` | Same but on an imported `.pptx` — confirms the bug isn't synthetic-deck-specific. |
| `tests/e2e/__diagnostic__/text-edit-deep.spec.mjs` | Mutation observer + canvas poller logs every DOM change during dblclick. |
| `tests/e2e/__diagnostic__/editor-position-math.spec.mjs` | Dumps the inputs to Univer's `_fitTextSize` math at the moment of click. |

Run any with:
```
pnpm exec playwright test --config=playwright.diagnostic.config.ts <name>
```

## Recommendation

**Block v0.1.1 on a fork-patch that fixes `_fitTextSize` / `getEditRectState`.**
Shipping a Google-Slides-equivalent shell on an editor that can't edit text
is a credibility hit far larger than the polish wins from the UX audit. The
fork-patch is a half-day investigation in `slides-ui` + a small (~20 lines)
patch hunk; the probes above will tell you immediately whether the fix works.

Cosmetic polish remaining items (P7 theme side-panel, P10 recent-files
thumbnails) should defer until this is fixed — the shell isn't shippable
until users can actually type into it.

## Open — partial-text formatting via Shift+Arrow

Inside the slide editor, pressing `Shift+ArrowLeft` to extend the
selection by one character and then `Ctrl+B` should bold only the
selected range — producing two textRuns, one plain and one with `bl=1`.
Observed (`tests/e2e/__diagnostic__/inline-format-probe.spec.mjs` and
follow-ups): the resulting model has a SINGLE textRun covering the
whole content. Either Shift+Arrow doesn't actually extend the
DocSelectionManagerService range, or Ctrl+B is applying to the whole
content because the bold command can't read a partial-range selection.

Full-content Ctrl+A → Ctrl+B works fine (probed) — so the bold command
itself is wired correctly. The gap is in the Shift+Arrow → selection
extension path.

Probably another flag / context-value the editor needs that we haven't
set in the slides-ui patch. Worth a focused trace through the
DocSelectionManagerService when this becomes blocking.

## Open — Ctrl+K hyperlink popup never opens

Ctrl+K dispatches `casual-slides.command.insert-link` which lazy-starts
the docs-hyper-link plugin pair and calls
`doc.operation.show-hyper-link-edit-popup`. The popup never appears.

Univer's `shouldDisableAddLink` precondition
(`docs-hyper-link-ui/lib/es/index.js:242`) requires BOTH:

  1. A non-collapsed text range in the active DocSelectionManagerService
  2. `getCurrentUnitOfType(UniverInstanceType.UNIVER_DOC)` returns a unit

We satisfy (1) when the editor has Ctrl+A'd content, but (2) fails:
the slide editor's inner doc unit (`__INTERNAL_EDITOR__SLIDE_EDITOR`)
exists but isn't the "current" unit of type DOC — Univer's instance
service treats the slide unit as the focused one (which it is, at the
React/canvas level).

Three repair paths:

  a) Call `focusUnit(editorUnitId)` in the slides-ui patch when the
     editor activates. Risky — changes which unit drives the rest of
     the slide UI (toolbar state, status bar, etc.).
  b) Patch docs-hyper-link-ui's `shouldDisableAddLink` to fall back
     to checking the `FOCUSING_DOC` context flag when no doc unit is
     "current". Two-package patch chain to maintain.
  c) Build our own thin URL dialog (small React popup) that bypasses
     Univer's hyperlink plugin entirely. Bigger surface area but it
     means the link UI matches the rest of our chrome and we don't
     ride changes in `@univerjs/docs-hyper-link-ui`.

(c) is the right long-term answer; (a) is the cheapest stop-gap.
Marker for future investigator: same root cause as the partial-text
selection bug above — both are downstream of the editor's doc unit
not being instance-level focused.
