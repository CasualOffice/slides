# Research — Univer Slides 0.24.x

Technical brief on `@univerjs/slides` and `@univerjs/slides-ui` as the engine for Casual Slides. File paths reference our fork at `../univer-revamp/`.

For Univer's broader runtime (DI, plugin lifecycle, command bus, collab hook), see [`../../sheet/docs/RESEARCH.md`](../../sheet/docs/RESEARCH.md) — that brief is canonical for the bits sheet and slides share.

---

## 1. Project shape — slides packages

Two packages:

- **`@univerjs/slides`** — core: data model, types, default snapshot, scene-object provider. 20 source files. License Apache-2.0.
- **`@univerjs/slides-ui`** — editor: canvas controllers, slide-bar (thumbnail strip), sidebar (transform/arrange/fill panels), image popup, text-editing render controller, slide operations. 53 source files. License Apache-2.0.

Both are version-locked to the rest of Univer (sheet's RESEARCH brief covers this — never mix minors).

Slides depend on `@univerjs/docs` and `@univerjs/docs-ui` for rich text inside text frames, and `@univerjs/drawing` for image elements.

---

## 2. The slide data model — `ISlideData`

Defined in `../univer-revamp/packages/slides/src/types/interfaces/i-slide-data.ts:36`. Closely modeled on Google Slides API — which structurally aligns with OOXML PresentationML.

```ts
interface ISlideData extends IReferenceSource {
  id: string;             // unit id
  locale?: LocaleType;
  title: string;
  pageSize: ISize;        // logical canvas size
  body?: ISlidePageBody;  // pages + page order
}

interface IReferenceSource {
  master?:        { [id: string]: ISlidePage };
  handoutMaster?: { [id: string]: ISlidePage };
  notesMaster?:   { [id: string]: ISlidePage };
  layouts?:       { [id: string]: ISlidePage };
  lists?:         ILists;
}

interface ISlidePageBody {
  pages:     { [id: string]: ISlidePage };
  pageOrder: string[];
}
```

### `ISlidePage` — a slide, master, layout, or notes page

```ts
interface ISlidePage {
  id: string;
  pageType: PageType;              // SLIDE | MASTER | LAYOUT | HANDOUT_MASTER | NOTES_MASTER
  zIndex: number;
  title: string;
  description: string;
  pageBackgroundFill: IColorStyle;
  colorScheme?: ThemeColorType;
  pageElements: { [elementId: string]: IPageElement };
  slideProperties?: { layoutObjectId, masterObjectId, isSkipped };
  layoutProperties?: { masterObjectId, name };
  notesProperties?: { name };
  handoutProperties?: { name };
  masterProperties?: { name };
}
```

### `IPageElement` — anything on a slide

```ts
interface IPageElement {
  id: string;
  zIndex: number;
  left?, top?, width?, height?: number;
  angle?, scaleX?, scaleY?, skewX?, skewY?: number;
  flipX?, flipY?: boolean;
  title: string;
  description: string;

  type: PageElementType;  // SHAPE | IMAGE | TEXT | SPREADSHEET | DOCUMENT | SLIDE

  // Union field — exactly one of:
  shape?: IShape;
  image?: IImage;
  richText?: ISlideRichTextProps;

  /** @deprecated */ spreadsheet?: {...};
  /** @deprecated */ document?: IDocumentData;
  /** @deprecated */ slide?: ISlideData;

  // video: IVideo;    // not yet
  // line: ILine;      // not yet
  // table: ITable;    // not yet
  // chart: IChartProperties;  // not yet

  customBlock?: ICustomBlock;
}
```

**Critical:** `video`, `line`, `table`, `chart` are commented out in the union and the enum. The model anticipates them; the implementation doesn't have them. These are fork-patch work for P4 — see [`UNIVER_SLIDES_GAPS.md`](./UNIVER_SLIDES_GAPS.md#page-element-types).

The `@deprecated` `spreadsheet/document/slide` embeds suggest Univer pulled back from doc-in-slide / sheet-in-slide nesting. The data model still allows it but the implementation discourages it. Don't rely on it.

---

## 3. Slide lifecycle and unit registration

Identical pattern to sheet — `Univer` class, `IUniverInstanceService`, plugin lifecycle. The only difference:

```ts
univer.createUnit(UniverInstanceType.UNIVER_SLIDE, snapshot);
```

`UniverInstanceType.UNIVER_SLIDE` is the slide enum (vs `UNIVER_SHEET`, `UNIVER_DOC`).

`SlideDataModel` (`../univer-revamp/packages/slides/src/data-model/slide-data-model.ts:25`) is the unit model. It exposes:

- `getSnapshot(): ISlideData`
- `getPages(): { [id: string]: ISlidePage }`
- `getPageOrder(): string[]`
- `getPage(pageId): ISlidePage`
- `getActivePage(): ISlidePage` + `activePage$` observable
- `setName(name): void`
- `updatePage(pageId, pageData): void`
- `appendPage(...)`, `getActivePageId()`

⚠️ **`getRev/setRev/incrementRev` are stubs.** Comment in source (line 68-78):
```ts
override getRev(): number {
  return 0; // TODO@jikkai: slide has not implement collaborative editing yet
}
override incrementRev(): void { /* do nothing */ }
override setRev(_rev: number): void { /* do nothing */ }
```

This is the single biggest collab blocker. See [`UNIVER_SLIDES_GAPS.md`](./UNIVER_SLIDES_GAPS.md#collab-rev-tracking).

---

## 4. Slide operations — the editing surface

Defined in `../univer-revamp/packages/slides-ui/src/commands/operations/`:

| Operation | Purpose |
| --- | --- |
| `activate.operation.ts` | Switch active page |
| `append-slide.operation.ts` | Add a new slide |
| `insert-text.operation.ts` | Add a text element |
| `insert-shape.operation.ts` | Add a shape |
| `insert-image.operation.ts` | Add an image |
| `update-element.operation.ts` | Mutate element transform / properties |
| `delete-element.operation.ts` | Remove an element |
| `text-edit.operation.ts` | Enter / commit text edit on a frame |
| `set-thumb.operation.ts` | Update slide thumbnail |

⚠️ **All declared as `CommandType.OPERATION`, not `MUTATION`.** See `insert-text.operation.ts:40`:
```ts
export const SlideAddTextOperation: ICommand<ISlideAddTextParam> = {
  id: 'slide.operation.add-text',
  type: CommandType.OPERATION,    // ← not MUTATION
  handler: async (accessor, params) => { ... }
};
```

This means **`onMutationExecutedForCollab` will not fire for these.** The collab hook is correct on Univer's part, but the slide operations aren't using it.

Our options (Spike C):

1. **Patch the fork** — change slide element mutations to `CommandType.MUTATION`, refactor the handlers to follow Univer's mutation pattern (params describe state change, handler applies + emits inverse for undo). This is the principled fix and is upstream-eligible.
2. **Wrap operations with our own collab envelope** — keep the operations as-is, and after `executeCommand` resolves, capture the resulting state diff and broadcast that. More fragile (no inverse for undo), but avoids the fork patch.

Default plan: option 1. Cost ~1-2 weeks of fork work; benefit is permanent and upstream-eligible.

---

## 5. Slide rendering — canvas controllers

`@univerjs/slides-ui` ships:

- **`canvas-view.ts`** — slide → scene-object construction. Each `IPageElement` becomes a scene object (Univer's render-engine primitive).
- **`slide.render-controller.ts`** — page lifecycle on the canvas.
- **`slide-editing.render-controller.ts`** — text-frame editing (heavy FIXMEs around coupling with sheet editors; see source lines 162, 696, 727).
- **`slide-editor-bridge.render-controller.ts`** — bridges the slide canvas to the docs editor for in-place text editing.

The canvas is **shared with sheet's renderer** — same `engine-render` primitives. Scene objects, transform matrices, pointer event routing — all the same. If you've worked on sheet canvas perf (see `../sheet/docs/UNIVER_FORK_PERF.md`), the optimizations transfer.

Components for the editor UI (Sidebar, ArrangePanel, TransformPanel, FillPanel, SlideBar) are in `../univer-revamp/packages/slides-ui/src/components/`. We'll likely replace `Sidebar.tsx` and `SlideBar.tsx` with our own to match the Office look, but we can study them for the transform/arrange/fill panel logic.

---

## 6. Bootstrap — minimal browser mount

Reference: `../univer-revamp/examples/src/slides/main.ts`.

```ts
import { LocaleType, Univer, UniverInstanceType } from '@univerjs/core';
import { UniverDocsPlugin } from '@univerjs/docs';
import { UniverDocsUIPlugin } from '@univerjs/docs-ui';
import { UniverDrawingPlugin } from '@univerjs/drawing';
import { UniverFormulaEnginePlugin } from '@univerjs/engine-formula';
import { UniverRenderEnginePlugin } from '@univerjs/engine-render';
import { UniverSlidesPlugin } from '@univerjs/slides';
import { UniverSlidesUIPlugin } from '@univerjs/slides-ui';
import { UniverUIPlugin } from '@univerjs/ui';

const univer = new Univer({ locale: LocaleType.EN_US });
univer.registerPlugin(UniverRenderEnginePlugin);
univer.registerPlugin(UniverUIPlugin, {
  container: 'app',
  header: false, toolbar: false, footer: false,
  headerMenu: false, contextMenu: false,         // hide native chrome
});
univer.registerPlugin(UniverDocsPlugin);
univer.registerPlugin(UniverDocsUIPlugin);
univer.registerPlugin(UniverFormulaEnginePlugin); // pulled in by docs; harmless
univer.registerPlugin(UniverDrawingPlugin);
univer.registerPlugin(UniverSlidesPlugin);
univer.registerPlugin(UniverSlidesUIPlugin);

univer.createUnit(UniverInstanceType.UNIVER_SLIDE, snapshot);
```

The React-mount pattern is identical to sheet's `UniverRoot.tsx`. Copy and rename.

---

## 7. Facade API — `FUniver` for slides

Less mature than `FWorkbook`. The slides facade is partial — you'll work through `IUniverInstanceService` directly for most things in early phases.

Methods we'll use in P0/P1:

- `univerInstanceService.getCurrentUnitOfType<SlideDataModel>(UniverInstanceType.UNIVER_SLIDE)`
- `slideDataModel.getSnapshot()`
- `slideDataModel.getActivePage()`
- `commandService.executeCommand('slide.operation.add-text', params)`

Plan to write our own `univerSlideAPI.ts` wrapper (mirror sheet's `univerAPI.ts`) that hides the verbosity. Upstream PR candidate.

---

## 8. What sheet's RESEARCH brief covers that applies here

These bits transfer 1:1 — read them in sheet's brief, don't re-derive:

- DI-first runtime, plugin lifecycle stages (`Starting → Ready → Rendered → Steady`)
- Three execution primitives (`COMMAND` / `MUTATION` / `OPERATION`)
- `ICommandService` listener APIs (the slides project uses the same hook once the operations are patched to `MUTATION`)
- `IExecutionOptions` flags (`fromCollab`, `onlyLocal`, `syncOnly`, `fromChangeset`)
- `params.trigger` mutation attribution
- `params.__splitChunk__` chunking on large mutations
- Resource manager pattern (named plugin slots)
- Hiding native chrome via UI plugin config
- React mount pattern

---

## 9. pptx I/O is NOT in OSS

Same situation as xlsx. DreamNum's commercial `@univerjs-pro/exchange-client` handles it. For us this means: write our own bidirectional pptx ↔ `ISlideData` converter. See [`PPTX_PIPELINE.md`](./PPTX_PIPELINE.md).
