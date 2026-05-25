# Univer Slides — Gaps and Fork-Patch Plan

What `@univerjs/slides` / `@univerjs/slides-ui` ship today (v0.24.0) and what we need to add to ship Casual Slides. Each gap below maps to a concrete patch in `../univer-revamp/`.

Fork remote: `git@github.com:schnsrw/univer-revamp.git` · branch `dev` · **v0.24.0** (in sync with sheet's vendored copy as of 2026-05-25).

---

## Priority table

| # | Gap | Severity | Phase | Upstream-eligible? |
|---|---|---|---|---|
| 1 | Collab rev tracking on `SlideDataModel` | 🔴 Blocker for P2 | P0 spike, P2 land | Yes — clean upstream PR ✅ shipped on `slide/rev-tracking` |
| 1.5 | `_createSlide` race uses `getCurrentUnitOfType()!` instead of `renderContext.unit` | 🔴 Black-screen on prod | P0 spike, P0 land | Yes — clean upstream PR ✅ shipped on `slide/render-context-unit-fix` |
| 1.6 | `slide-editing.render-controller.ts:257` calls `.activate(...)` on stale doc renderer after `disposeUnit` | 🟡 Console noise on swap, no UX impact | P1 | Yes |
| 2 | Element operations declared as `OPERATION` not `MUTATION` | 🔴 Blocker for P2 | P0 spike, P2 land | Yes — V1 shipped (`slide.command.add-text` → `slide.mutation.insert-element`) on `slide/element-mutations`. Sibling ops (insert-shape, insert-image, update-element, delete-element, append-slide) pending on the same branch. |
| 3 | Missing element types (table, chart, line, video) | 🟡 Limits P4 breadth | P4 | Yes — model + render |
| 4 | Animations / transitions not modeled | 🟡 Limits P5 | P5 | Maybe — model addition is large |
| 5 | Speaker notes UI absent (model exists) | 🟢 Polish | P4 | Yes |
| 6 | Master/layout editor UI absent | 🟢 Polish | P4 | Yes |
| 7 | pptx I/O not in OSS | 🟢 We own it ourselves | P0 spike, P1 land | No — Pro feature |
| 8 | Facade API for slides is partial | 🟢 DX | P1 ongoing | Yes — incremental PRs |
| 9 | Slide-editing controller coupled to sheet editors (FIXMEs) | 🟢 Tech debt | P3 if it bites | Yes |
| 10 | Default theme + color scheme picker shallow | 🟢 Polish | P4 | Yes |

---

## Gap 1 — Collab rev tracking

### What's missing

`SlideDataModel.getRev/setRev/incrementRev` are no-ops. From `../univer-revamp/packages/slides/src/data-model/slide-data-model.ts:68-78`:

```ts
override getRev(): number {
  return 0; // TODO@jikkai: slide has not implement collaborative editing yet
}
override incrementRev(): void { /* do nothing */ }
override setRev(_rev: number): void { /* do nothing */ }
```

This breaks: undo/redo across collab (peers can't reason about rev order), snapshot-vs-update sequencing on the joiner fast-path, and divergence detection.

### Patch plan

Mirror the sheet implementation. `Workbook` (the `UnitModel` for sheets) implements rev as a private counter that increments on each mutation. See `../univer-revamp/packages/core/src/sheets/workbook.ts` for the reference shape.

Concretely in `slide-data-model.ts`:

```ts
private _rev = 0;

override getRev(): number { return this._rev; }
override setRev(rev: number): void { this._rev = rev; }
override incrementRev(): void { this._rev += 1; }
```

Plus: wire `incrementRev()` into the mutation handlers we add in Gap 2. Add a unit test (`slide-data-model.spec.ts` exists already — extend it).

**Estimated effort:** 1-2 days including tests.

**Upstream PR title:** `feat(slides): implement rev tracking on SlideDataModel`.

---

## Gap 2 — Element operations declared as `OPERATION` not `MUTATION`

### What's missing

`onMutationExecutedForCollab` (the canonical collab hook, used by sheet) fires only for `CommandType.MUTATION`. But every slide element operation in `../univer-revamp/packages/slides-ui/src/commands/operations/` is declared `CommandType.OPERATION`. Reference: `insert-text.operation.ts:40`:

```ts
export const SlideAddTextOperation: ICommand<ISlideAddTextParam> = {
  id: 'slide.operation.add-text',
  type: CommandType.OPERATION,       // ← wrong type for state mutations
  handler: async (accessor, params) => { ... }
};
```

This is incorrect by Univer's own convention — `OPERATION` is "transient/UI state, no persisted snapshot change" (`../univer-revamp/packages/core/src/services/command/command.service.ts:38`). Adding/deleting/transforming elements is a persisted state change.

### Patch plan

Refactor each operation into the standard COMMAND + MUTATION pair Univer uses for sheet:

```ts
// Public command — the "intent"
export const SlideInsertTextCommand: ICommand<ISlideInsertTextParam> = {
  id: 'slide.command.insert-text',
  type: CommandType.COMMAND,
  handler: (accessor, params) => {
    const cs = accessor.get(ICommandService);
    const undoRedo = accessor.get(IUndoRedoService);

    const mutationParams = buildInsertTextMutation(params);
    const inverseParams  = buildDeleteElementMutation(params.unitId, mutationParams.elementId);

    const result = cs.syncExecuteCommand(SlideInsertElementMutation.id, mutationParams);
    if (!result) return false;

    undoRedo.pushUndoRedo({
      unitID: params.unitId,
      undoMutations: [{ id: SlideDeleteElementMutation.id, params: inverseParams }],
      redoMutations: [{ id: SlideInsertElementMutation.id, params: mutationParams }],
    });
    return true;
  },
};

// State-changing mutation — broadcast for collab
export const SlideInsertElementMutation: IMutation<ISlideInsertElementMutationParams> = {
  id: 'slide.mutation.insert-element',
  type: CommandType.MUTATION,
  handler: (accessor, params) => {
    const instances = accessor.get(IUniverInstanceService);
    const model = instances.getUnit<SlideDataModel>(params.unitId);
    if (!model) return false;
    const page = model.getPage(params.pageId);
    if (!page) return false;
    page.pageElements[params.element.id] = params.element;
    model.updatePage(params.pageId, page);
    model.incrementRev();
    return true;
  },
};
```

Operations to refactor (one mutation pair each):

- `slide.operation.add-text` → `slide.command.insert-text` + `slide.mutation.insert-element` (+ inverse `delete-element`)
- `slide.operation.insert-shape` → same pattern
- `slide.operation.insert-image` → same pattern
- `slide.operation.update-element` → `slide.mutation.update-element` (params: delta of transform + properties)
- `slide.operation.delete-element` → `slide.mutation.delete-element`
- `slide.operation.append-slide` → `slide.mutation.insert-page` + `slide.mutation.delete-page` inverse
- `slide.operation.text-edit` → richText updates land via doc-mutations (the text frame is a doc unit); investigate whether we need a slide-mutation envelope around them. **Open question for Spike C.**
- `slide.operation.activate` → stays `OPERATION` (it's transient UI state — selecting active page is not persisted)
- `slide.operation.set-thumb` → stays `OPERATION` (UI hint only)

The `set-thumb` and `activate` operations are correctly typed today. The others are not.

### Risks

- Refactor is touching the slide-editing render controllers, which have known FIXMEs (Gap 9). Likely lands some incidental cleanup.
- The text-edit path is the open question — text inside a frame goes through `@univerjs/docs` mutations on a nested doc unit. The doc mutations *should* already fire `onMutationExecutedForCollab`. Need to confirm in Spike C whether they reach the slide unit's collab subscriber, or whether we need to forward them.

**Estimated effort:** 1-2 weeks.

**Upstream PR title:** `refactor(slides): route element mutations through CommandType.MUTATION`.

---

## Gap 3 — Missing element types

### What's missing

From `i-slide-data.ts:137-140`:

```ts
// video: IVideo;            // not yet
// line: ILine;              // not yet
// table: ITable;            // not yet
// chart: IChartProperties;  // not yet
```

And from `PageElementType` enum:

```ts
export enum PageElementType {
  SHAPE, IMAGE, TEXT, SPREADSHEET, DOCUMENT, SLIDE,
  // no TABLE, CHART, LINE, VIDEO
}
```

### Patch plan (P4 work)

For each new type, three pieces:

1. **Model** — add the interface + extend the union + extend the enum in `i-slide-data.ts`. Migrate `SlideDataModel` parsing.
2. **Render** — add an adapter in `../univer-revamp/packages/slides/src/views/render/adaptor.ts` and `object-provider.ts`. Each element type becomes a scene object on the canvas.
3. **Operations** — add insert/update mutations following the Gap 2 pattern.

Approximate order:

- **Lines/connectors** (P4 early). Simplest — extension of shape with line-specific props. ~1 wk.
- **Tables** (P4). Most complex — table is a 2D structure with row/column data; could lean on `IWorksheetData` reuse (but that's deprecated). Likely a fresh `ITable` interface. ~2-3 wks.
- **Charts** (P4 late). Use ECharts as canvas overlay anchored to element bounds, same pattern as sheet's chart layer. ~2 wks.
- **Video** (P5). Add `<video>` element overlaying the canvas; handle media bytes in resources. ~1 wk for basics.

**Estimated total effort:** 6-8 wks across P4-P5.

**Upstream PR titles:** four separate PRs, one per element type. Each upstream-eligible.

---

## Gap 4 — Animations and transitions

### What's missing

Univer's `ISlidePage` has no animation timeline. No transition properties between pages.

### Patch plan (P5 work)

Two approaches:

**A. Plugin via `resources` slot (no fork patch needed).** Register a plugin key like `CASUAL_SLIDES_ANIMATIONS` and store our animation data in `ISlideData.resources`. The slide canvas remains static; we drive animation playback in our own React layer during presenter mode.

Pros: zero fork churn. Approach maps cleanly onto how sheet added CF/DV/charts via resources.
Cons: round-trip through pptx requires us to own the OOXML mapping; Univer's renderer never sees the animations.

**B. Model-level addition to `ISlidePage`.** Add `animations: IAnimationStep[]` and `transition: ITransition` to the page interface.

Pros: makes animations a first-class slide concept.
Cons: large model change; non-trivial upstream review.

**Default plan:** A for P5. Revisit B if we find ourselves fighting it.

---

## Gap 5 — Speaker notes UI

### What's missing

`notesMaster` and the `NOTES_MASTER` page type are in the model. There's no notes editor panel.

### Patch plan (P4)

Two pieces:

1. Our own React `NotesPanel.tsx` component below the slide canvas. Edits a docs unit nested in the active slide's notes page.
2. Wire pptx import to extract `notesSlide*.xml` per slide into the model.

No Univer-source patch needed for the basic UI — just docs-unit reuse. ~3-5 days.

---

## Gap 6 — Master / layout editor

### What's missing

Same shape as notes — model has masters and layouts, no editor UI for them.

### Patch plan (P4)

A "Slide Master View" mode in our shell (Office has the same — View → Slide Master). When entered, the slide-bar lists masters and layouts; the canvas edits a master/layout page instead of a regular slide. The Univer engine treats master/layout pages as just pages with a different `PageType` — no engine work needed. UI-only.

~1 wk.

---

## Gap 7 — pptx I/O

### What's missing

DreamNum's `@univerjs-pro/exchange-client` is the only Univer-shipped pptx implementation, and it's Pro/closed.

### Patch plan

We own this. Full spec: [`PPTX_PIPELINE.md`](./PPTX_PIPELINE.md).

Not a fork patch — a separate package in `apps/web/src/pptx/`.

---

## Gap 8 — Slide facade API

### What's missing

Compared to `FUniver`'s rich sheet surface (`FWorkbook`, `FWorksheet`, `FRange` with dozens of methods), the slides facade is partial. Most slide operations require working through `IUniverInstanceService` and `commandService.executeCommand(...)` directly.

### Patch plan

Write `../univer-revamp/packages/slides/src/facade/` mirroring sheet's pattern:

- `FSlide` — wraps `SlideDataModel`. Methods: `getPages()`, `getActivePage()`, `setName()`, `appendPage()`, `removePage()`, `getSnapshot()`, `save()`.
- `FPage` — wraps `ISlidePage`. Methods: `getElements()`, `addText()`, `addShape()`, `addImage()`, `removeElement()`, `setBackground()`.
- `FElement` — wraps `IPageElement`. Methods: `setTransform()`, `setProperties()`, `bringForward()`, `sendBackward()`.

This is mostly thin wrapping over the COMMAND ids we register in Gap 2.

Incremental upstream PRs as we go. **Estimated effort:** 1-2 wks spread across phases.

---

## Gap 9 — Slide-editing controller coupling

### What's missing

`../univer-revamp/packages/slides-ui/src/controllers/slide-editing.render-controller.ts` has multiple FIXMEs noting it's coupled to sheet editors (e.g. line 162, 696, 727). The text-editing path was lifted from sheet's cell editor and the abstractions leak.

### Patch plan

Defer until it actively breaks something. If text-frame editing in collab (P2) is buggy because of cross-doc state leaking, lift the editing logic into a slides-only controller. ~1 wk if/when needed.

---

## Gap 10 — Theme picker

### What's missing

`colorScheme` is in the model. No UI for picking themes; no theme catalog.

### Patch plan (P4)

Office-style Design tab in the ribbon. Ships a small catalog of themes (color scheme + font scheme combos). Applies via a slide-level mutation that updates `colorScheme` on each page.

Curate ~12 themes for v1 (PowerPoint ships ~50). ~3-5 days.

---

## Fork management strategy

### Option A — patches over npm packages (sheet's pattern) ✅ adopted

Consume `@univerjs/*` from npm. Maintain patches as `pnpm patch` artifacts in [`/patches/`](../patches/), registered under `pnpm.patchedDependencies` in [`/package.json`](../package.json). Sheet uses this for `@univerjs/sheets-table-ui` and `@univerjs/sheets-ui`.

Pros: minimal workspace plumbing; easy Univer version bumps; CI doesn't need the fork checked out.
Cons: patch diffs grow with each release; multi-file refactors (Gap 2) are awkward to author.

### Option B — wire the fork via pnpm `overrides` ❌ rejected

We tried `overrides: { "@univerjs/slides": "link:../univer-revamp/packages/slides" }`. **It doesn't resolve** because the fork's `slides` package declares `"@univerjs/core": "workspace:*"` and our workspace doesn't contain core — pnpm can't satisfy `workspace:*` across workspaces. Working around it (nested workspace inclusion, building the fork to `lib/es/` and linking that, tarball-pack) is more plumbing than Option A's cost.

### Option C — republish the fork under our scope

Build `@melp/univer-*` tarballs from the fork and publish to a private registry.

Pros: production builds don't need the fork checked out; arbitrary refactors are fine.
Cons: registry + CI plumbing.

### Plan

- **v0.0.x: Option A.** All Gap patches authored as `pnpm patch` diffs. The Gap 2 refactor is big but still a single-file-per-operation diff — manageable.
- **v0.1.x or earlier if a patch crosses 500 lines: Option C.** Stand up `@melp/univer-slides`, `@melp/univer-slides-ui` republished from the fork's `dev` branch.

### Authoring workflow

```
# 1. Land the change in the fork (sets up the upstream PR)
cd ../univer-revamp
git checkout -b feat/slides-rev-tracking dev
# edit packages/slides/src/data-model/slide-data-model.ts
git commit -am "feat(slides): implement rev tracking on SlideDataModel"
git push origin feat/slides-rev-tracking  # opens upstream PR to dream-num/univer

# 2. Mirror the diff as a patch on point's npm install
cd ../point
pnpm patch @univerjs/slides@0.24.0
# pnpm prints a tmp path — edit the same lines there
pnpm patch-commit /tmp/.../node_modules/@univerjs/slides
# this writes patches/@univerjs__slides@0.24.0.patch and updates package.json
git add patches/ package.json
git commit -m "patch(slides): rev tracking — mirrors univer-revamp#NNN"

# 3. When upstream merges and a Univer release ships, bump the dep and drop the patch.
```

---

## Open decisions for Spike C (P0)

1. Confirm in code: do doc mutations inside a text frame surface through the slide unit's collab subscriber? (Determines whether Gap 2 includes text-edit forwarding.)
2. Validate the rev-tracking implementation under concurrent mutations from two browsers (does sheet's pattern work as-is, or are there slide-specific edge cases?).
3. Decide A vs B for animations early enough that P4 element-type work doesn't paint into a corner.
