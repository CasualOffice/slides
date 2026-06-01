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

## Hypothesis

The `slideMainRect.left / .top` (the slide rect's position **inside the scene
coordinate system**) is producing a value that doesn't match where the slide
actually paints to the user. Specifically: the scene-anchor seems to be
positioned far enough off the canvas origin that `canvasOffset` becomes a
large negative number, pulling the editor overlay off-screen.

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
