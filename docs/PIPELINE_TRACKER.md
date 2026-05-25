# Pipeline tracker

Single-user feature parity with Google Slides. Each row is independently
shippable. Multi-agent execution: each item below maps to one agent in a
git worktree, branched off `main`, pushed under its `branch` name.

Update this file when an item lands or shifts ownership.

## Sprint 1 — small parallel features

| # | Feature                          | Owner   | Branch                     | Status     | Notes |
|---|----------------------------------|---------|----------------------------|------------|-------|
| 1 | Properties dialog                | main    | `main`                     | ✅ landed   | **Feature**. File → Properties → modal with title / slide count / page size / element count / text length / format. Esc + click-outside close. |
| 2 | Slide-bar right-click menu       | main    | `main`                     | ✅ landed   | **Feature**. Right-click thumbnail → New / Duplicate / Delete. DOM-walks to find the thumbnail's slide-index span; suppresses native context menu. |
| 3 | Image export round-trip          | main    | `main`                     | ✅ landed   | **Fidelity**. `IMAGE` page elements now embed into `ppt/media/` on export via PptxGenJS `addImage({ data: 'data:image/png;base64,…' })`. Prefer `contentUrl`, fall back to `base64Cache`; default MIME `image/png`. Round-trip test asserts media entries exist after export. |

Parallel agent dispatch hit the org's monthly usage limit (3 spawned, 0 progress). Sprint 1 is being completed sequentially on `main`.

Each sprint balances feature + fidelity work — we are an editor as well as a pptx reader; parity on both axes.

## Sprint 2 — sequential (after sprint 1 merges)

| # | Feature                          | Owner | Status   | Notes |
|---|----------------------------------|-------|----------|-------|
| 4 | Background color picker          | main  | ✅ landed | Feature. Toolbar "Background" → 16-chip palette popover + custom color input + "Apply to all" toggle. Dispatches `slide.mutation.update-page` for the active slide (or every page when toggle on). |
| 5 | Selection-aware text formatting  | -     | planned  | Feature. Bold/Italic/Underline buttons active when a text frame is selected. Needs UX design (floating context bar vs sticky toolbar). |
| 6 | Pptx import fidelity — wave 1    | main  | ✅ landed | Fidelity. Re-imported decks were "text only, no properties, images vanished". Wave 1 lands (a) first-run text props (size / bold / italic / underline / color from `<a:rPr>` + `<a:solidFill><a:srgbClr>`), (b) image extraction — `<p:pic><a:blip r:embed>` resolves via per-slide rels file to `ppt/media/*` bytes, returned as `data:image/<ext>;base64,…`, and (c) shape geometry — non-text `<p:sp>` parses `<a:prstGeom prst>` for shape type, `<a:solidFill><a:srgbClr>` for fill, and `<a:ln>` for outline (previously every non-text shape became a white rect). Element IDs now per-page-unique (`s${n}-el-${z}`). |
| 7 | Recent files (IndexedDB)         | main  | ✅ landed | Feature. File → "Recent files" modal lists up to 10 recently-opened decks (sorted newest-first) and re-opens via the same import path. Bytes stored in IDB so the round-trip survives a page reload; de-dup by name+size refreshes openedAt instead of stacking duplicates. Caveat surfaced during build: JSZip transfers the input ArrayBuffer to a worker, detaching it — we snapshot a copy before handing off to the importer so the IDB persist gets durable bytes. |
| 8 | About dialog                     | -     | planned  | Feature. Help → About — version, repo, license. |
| 9 | Slide layouts                    | -     | planned  | Feature. "New Slide" dropdown with 6 layout templates. |

## Sprint 3 — fidelity + depth

| # | Feature                          | Owner | Status   | Notes |
|---|----------------------------------|-------|----------|-------|
| 10 | Master / layout passthrough     | -     | planned  | Fidelity. Round-trip via `resources["CASUAL_SLIDES_PPTX_RAW"]`. |
| 11 | Theme colors / fonts round-trip | -     | planned  | Fidelity. Map `<a:clrScheme>` and `<a:fontScheme>` from `ppt/theme/theme1.xml`. |
| 12 | Find and replace                | -     | planned  | Feature. Modal + iterate all text elements. |
| 13 | Comments                        | -     | planned  | Feature. Anchor comments to slides via `resources` slot. |

## Sprint 4 — co-editing (after single-user parity)

Per user direction, P2 collab work resumes only after sprints 1–3 land.

| # | Feature                          | Owner | Status   | Notes |
|---|----------------------------------|-------|----------|-------|
| 13 | Yjs upgrade for CRDT correctness | -     | planned  | Replace raw-broadcast in apps/server with Y.Doc state vectors. Bridge stays. |
| 14 | Presence (cursors / avatars)     | -     | planned  | Use Awareness protocol from y-protocols. |
| 15 | Snapshot fast-path on join       | -     | planned  | Late joiners receive the current snapshot, not just deltas. |

## Conventions

- **Branch off `main`** at the time of agent dispatch.
- **No dependencies between sprint-1 items** — agents may all run in parallel.
- **One new component per item** under `apps/web/src/shell/`; touches to `App.tsx` / `Toolbar.tsx` / `styles.css` are unavoidable and resolved at merge time.
- **Commit messages** follow conventional commits (`feat(scope): subject`). No `Co-Authored-By: Claude` trailer (project rule).
- **Tests** — each item adds at least one Playwright assertion in `tests/e2e/smoke.spec.ts` and verifies `pnpm typecheck` + the smoke suite stays green.
