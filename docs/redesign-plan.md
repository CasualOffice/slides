# Casual Slides — UI/UX Redesign Plan (against `@schnsrw/design-system`)

Replace the entire hand-rolled UI layer with the **design-book** ui-kit, preserving
all features and the Univer wiring. Verified live in the running app per phase.

> **Source of truth:** `design-book/docs/design-book/*.md` (read 01→07) + the exported
> components in `@schnsrw/design-system`. Rule: **no hardcoded hex / px / shadows** — only
> kit components + `var(--token)`.

## Inputs (from audit)

**Kit provides:** `Button`, `IconButton` (with `pressed`), `Input`, `Select`, `Checkbox`,
`Switch`, `Dialog`, `Menu`, `Tooltip`, `Tabs`, `Icon` (Material Symbols), `Badge`, `Pill`,
`Avatar`/`AvatarStack`, `Card`, `Kbd`. Tokens via `@schnsrw/design-system/tokens.css`
(colors/surfaces, type Inter+Mono+Manrope, 4px spacing, radius/shadow ladders, motion,
chrome-height vars). Dark mode = `data-theme="dark"`; accent override = `[data-app="slides"]`.

**Kit gaps to build in `apps/web/src/ui/` (tokenized, no raw values):** `Popover`,
`ColorPicker`, `NumberStepper`, `Slider`, `Ribbon`/`ToolbarGroup`, `Combobox` (font picker),
`Toast`, splitter (use CSS grid). Build these once; reuse everywhere.

**Product surfaces to rebuild (18):** TitleBar, Toolbar(959 LOC), SlideRail, FormatPane
(1327 LOC), StatusBar, NotesPanel, context menus, ThemePicker, BackgroundPicker, LayoutPicker,
PageSetupDialog, PropertiesDialog, RecentFilesDialog, AboutDialog, FindReplaceDialog,
PresenterView, SlideShow, OverflowPopover.

**Preserve (do NOT change):** `dispatchSlideCommand()` + command ids, `window.univer` /
`IUniverInstanceService` model access, the App→Providers→shell tree, snapshot-keying remount.

## Phases (each ends green + visually verified in the app)

### R0 — Foundation & wiring
- Add `@schnsrw/design-system: workspace:*` to `apps/web` deps (it's a workspace submodule;
  ships `dist/` + `tokens.css`, no build needed).
- Import `@schnsrw/design-system/tokens.css` at entry; set `data-app="slides"` + theme attr.
- **Resolve the bundle blocker**: drop the `@univerjs/*/lib/index.css` imports in
  `univer-styles.ts` (built artifacts that don't exist in source); the engine packages import
  their own CSS from source, and chrome styling moves to the kit tokens.
- Map the shell grid to the kit's chrome-height tokens (titlebar/toolbar/statusbar).
- Keep the old `.cs-*` CSS alive during migration (delete per-surface as it's replaced).

### R1 — Primitives & dialogs (highest reuse)
- All buttons → `Button` / `IconButton` (`pressed` for toggles like bold/italic).
- TitleBar menu strip + both context menus → `Menu` (+ the new `Popover` for positioning).
- Consolidate **all dialogs** onto kit `Dialog` (Theme/Properties/About/Recent/PageSetup/
  FindReplace) — one header/footer/scrim, focus trap, Esc.
- Inputs/selects (filename, search, FormatPane fields) → `Input`/`Select`/new `NumberStepper`.
- Shortcuts surfaced via `Kbd` + `Tooltip` (label + shortcut) on icon buttons.

### R2 — Gap components
Build `Popover`, `ColorPicker` (replaces the 3 hardcoded palettes), `Slider` (zoom),
`NumberStepper` (size/position/spacing), `Combobox` (font picker with preview), `Toast`
(save/undo status), `Ribbon`/`ToolbarGroup` (Tabs + grouped IconButton clusters).

### R3 — Major surfaces
- **Toolbar → Ribbon** (Insert/Design/Transitions tabs; grouped controls; kit overflow `Menu`).
- **FormatPane** rebuilt with kit forms + the new steppers/color pickers; **also fix the
  collab-unsafe direct snapshot writes** → route through the engine facade (`FSlide`/`FElement`)
  / mutations, and use the engine's `shadow`/`gradientFill` (replacing the product's
  expected `effectLst`). Resolves both UX and the 0.25 API mismatch.
- **SlideRail**: kit surfaces/elevation, visible (not hover-only) actions, a11y labels.
- **TitleBar / StatusBar / NotesPanel**: kit components + tokens; styled `Slider` for zoom.
- **PresenterView / SlideShow**: kit layout + tokens.

### R4 — Polish
Focus-visible everywhere (kit `--glow-accent`), keyboard nav (menu arrows, dialog trap),
dark mode, calm motion (`.cs-anim-*`), empty/error states, responsive floor (360px),
delete the residual `.cs-*` CSS.

## Also reconciled along the way (the bundle/typecheck blockers)
- `@univerjs/*/lib/index.css` → source CSS + kit tokens (R0).
- `IShapeProperties.effectLst` → engine `shadow`/`gradientFill` (R3 FormatPane).
- `IParagraph.paragraphId`, nullable `pageSize` → small non-UI fixes (do early, R0/R1).

## Sequencing note
R0 unblocks the build; R1–R2 give the vocabulary; R3 is the bulk; R4 is polish. Each phase
is a reviewable PR verified in the running app. The engine (univer-revamp) is already
feature-complete for >90% import fidelity, so this redesign is purely the product UI layer.
