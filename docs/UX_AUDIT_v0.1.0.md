# UX / UI audit — Casual Slides v0.1.0

**Date:** 2026-06-01 · **Auditor:** non-UI/UX lane · **Method:** drove the live `:5373` dev server through every major surface in a 1440×900 headless Chromium session (screenshots in `/tmp/casual-slides-ux-audit/`), then code-mapped every shell component for file:line citations. Compared against Google Slides (Chrome desktop) and PowerPoint Online (Edge desktop) as the industry benchmarks.

**Verdict at a glance:** the editor is a competent Google-Slides-adjacent shell with strong keyboard + .pptx fidelity foundations. The polish gap to "indistinguishable from Google Slides on first impression" is **mostly discoverability and visual hierarchy**, not missing capability. Most fixes are 1–3 hour CSS / wiring changes, not feature builds.

This doc is audit output, not code. Implementation is the parallel UI/UX lane's call.

---

## Executive findings

| Category | Score (1–5) | Honest read |
|---|---|---|
| **Layout & information architecture** | 4 / 5 | Two-row titlebar + menu strip + toolbar + rail + canvas + format pane + status bar reads as one app. Strong bones. |
| **Discoverability for new users** | 2.5 / 5 | Theme / Background / Layout collapsed under `Slide ▾` are findable but slower than Google's menu-level access. No Format menu hurts text formatting discovery. |
| **Visual polish (chrome)** | 3.5 / 5 | Brand is good. Toolbar density is reasonable. Status bar is bare. Menu items lack icons. |
| **Visual polish (canvas)** | 4 / 5 | The slide rail renders real canvas thumbnails (not text). Theme cards have live "Aa" previews. Layout picker has SVG previews. |
| **Keyboard story** | 4.5 / 5 | Shortcuts dialog covers 7 sections, ~50 shortcuts, platform-aware glyphs. `Ctrl+/` opens it. Few editors do this well. |
| **Accessibility** | 3 / 5 | Aria-labels mostly present; focus traps on dialogs. Touch targets below 44×44, text-dim contrast now at 4.94:1 (AA). |
| **Polish on dialogs** | 3 / 5 | Backdrop + card idiom is consistent. About has dependency credits — a nice touch. Properties is too sparse. |

---

## Showstopper polish gaps (fix before any user testing)

These are the things a user coming from Google Slides will notice in the first **10 seconds**. None are missing features — they're discoverability or visual-hierarchy gaps that make the app feel less polished than it actually is.

### S1. No `Format` menu in the menu strip — discoverability cliff
- **File:** `apps/web/src/shell/TitleBar.tsx:66–107` (`buildMenus`)
- **Current:** 5 menus — File · Edit · View · Insert · Help.
- **Industry:** Google Slides ships **9** menus including `Format`, `Slide`, `Arrange`, `Tools`. PowerPoint Online uses a ribbon but exposes equivalent surfaces.
- **Why it matters:** A user looking for "change font color" / "alignment" / "line spacing" instinctively opens `Format`. There's no Format menu, so they hunt the toolbar. **The features exist; they're just not where users expect.**
- **Fix shape:** Add a `Format` menu (Text · Paragraph · Bullets · Line spacing · Clear formatting) that mirrors the toolbar's Group 6 + Group 7. Add a `Slide` menu (Layout · Theme · Background · Transition · Delete) that mirrors the `Slide ▾` toolbar dropdown. Don't remove the toolbar dropdowns — these are *additional* paths for discovery.

### S2. `Slide ▾` toolbar dropdown obscures Layout / Theme / Background
- **File:** `apps/web/src/shell/Toolbar.tsx:436–730`
- **Current:** Layout / Theme / Background live inside a collapsed `Slide ▾` button.
- **Industry:** Google Slides has these as **inline toolbar items** with their own icons (`Background`, `Layout`, `Theme`). They sit between `+` (new slide) and `Transition`.
- **Why it matters:** Each click into `Slide ▾` is an extra step; the user has to remember "ah, that's under Slide." This is the single biggest reason the 4 still-failing smoke tests timed out (they expected top-level buttons).
- **Fix shape:** Surface Theme / Background / Layout as inline toolbar buttons in their own group between the New-slide button and the font-family picker. Keep `Slide ▾` as a fallback that contains lesser-used items (Hide / Skip / Reset layout).

### S3. Status bar is bare — wastes a launchpad
- **File:** `apps/web/src/shell/StatusBar.tsx:23–94`
- **Current:** "Slide N of M" · Normal view · Notes toggle · Zoom controls.
- **Industry:** Google Slides status bar exposes **Theme · Comments · Settings · Present (Slideshow)** as 4 prominent shortcuts to the most-used surfaces. PowerPoint Online has fewer but still surfaces Comments + Present.
- **Why it matters:** The bottom-right of the screen is **prime real estate for Present** (the action users want when their deck is done). Burying it in the top-right toolbar means it's far from the user's mouse during the final review.
- **Fix shape:** Add a `Present` icon-button to the right of the zoom slider (mirroring Google Slides). Optionally add a Theme shortcut and a Comments placeholder.

### S4. Filename input shows debug name "Casual Slides — Spike A"
- **File:** the default `DEFAULT_SLIDE_DATA.title` in `apps/web/src/default-slide.ts` (not in shell map but referenced via `TitleBar.tsx:158`)
- **Current:** Cold-boot deck is named **"Casual Slides — Spike A"** — leftover P0 spike naming.
- **Industry:** Google Slides defaults to **"Untitled presentation"**. PowerPoint Online defaults to **"Presentation"**.
- **Why it matters:** The first thing the user sees in the titlebar is a debug string. Reads as "alpha" rather than "v0.1".
- **Fix shape:** Change the default snapshot's `title` to `"Untitled presentation"` and the body content's first slide to use a generic title (e.g. an empty title placeholder) instead of "Casual Slides" / "PowerPoint-flavored web presentations".

### S5. Menu items have no icons
- **File:** `apps/web/src/shell/TitleBar.tsx:66–107` (menu definition) and the menu render code
- **Current:** Plain text rows with shortcut hints on the right. No icons.
- **Industry:** Google Slides menu items have **left-anchored icons** (16 px). PowerPoint Online's ribbon does the same.
- **Why it matters:** Icons are scan-anchors. Users scanning the File menu for "Download" instinctively look for a download arrow. Without icons, every item reads as plain text and the eye has to parse each one.
- **Fix shape:** Add an `icon?: string` field to the menu item shape. Pre-supply icons for the 30 items in `buildMenus`. Leverage the existing `<Icon name=…>` component. Effort: ~1 h.

---

## Polish gaps (fix during the v0.1 → v0.2 polish window)

### P1. Brand mark is small relative to Google Slides
- **File:** `TitleBar.tsx:292` (28 × 36 logo, `<img src={brand.svg}>`)
- **Industry:** Google Slides' logo is 40 × 40 in their two-row titlebar. PowerPoint Online's is 32 × 32 with a bolder color saturation.
- **Fix:** Bump to 32 × 40 and add 8 px right-margin. The new teal SVG looks under-confident at its current size.

### P2. Filename indicator + Saved chip placement is non-standard
- **File:** `TitleBar.tsx:273–335` (filename) + `336–367` (Saved chip)
- **Current:** Filename and "Saved" chip are stacked side-by-side. They're visually equal weight.
- **Industry:** Google Slides puts the saved indicator **inline after the filename** as quieter copy ("Last edit was 2 minutes ago"). PowerPoint Online uses a tiny green dot.
- **Fix:** De-emphasize the Saved chip (smaller font, lighter color, or move to inline grey text after the filename). Match Google's pattern: filename is bold, save state is whisper.

### P3. Slide rail thumbnails don't show on-hover action buttons
- **File:** `apps/web/src/shell/SlideRail.tsx:336–338`
- **Current:** Rail thumbnails are real canvas miniatures (good). Hover shows just a teal border highlight. Action buttons (Duplicate / Hide / Delete) are right-click-only.
- **Industry:** Google Slides shows **3 icon buttons inline on hover** (︙ menu, Comment, Insert). PowerPoint Online uses right-click only (Casual matches PPT here, not Google).
- **Fix:** Add `:hover` action overlay with Duplicate / Delete icons (16 px) anchored top-right of the thumbnail. Right-click still works for power users. Effort: CSS + a small `<div className="cs-slide-rail__hover-actions">` block.

### P4. Slideshow CTA color is brand-teal — too dominant
- **File:** `Toolbar.tsx:639–652` (the `Slideshow` accent button at the right end of the toolbar)
- **Current:** Solid teal background with white text + play icon. Reads as the *single most important action in the app*, but it's only used at the END of editing (when you're done and want to present).
- **Industry:** Google Slides' "Slideshow" is a **ghost button** with a small dropdown caret (allowing presenter mode choice). PowerPoint Online's "From Beginning" is similar.
- **Fix:** De-saturate to a ghost-style button (text + icon, no fill) OR move the present action to the status bar per S3 above. The toolbar should accent **Save** (more frequent) over **Slideshow**.

### P5. Format pane lacks Opacity (Univer v0.24.0 limitation, but flag prominently)
- **File:** `FormatPane.tsx:34–37` (deliberate comment); sections 313–333
- **Current:** Fill / Border / Shadow are present. Opacity intentionally absent because Univer v0.24.0's `IShapeProperties` has no alpha field.
- **Industry:** Both Google Slides and PowerPoint Online have an opacity slider in their right-rail format pane.
- **Fix:** Add a disabled-with-tooltip opacity slider that says "Coming with the next Univer upgrade" so users see it's tracked, not forgotten. OR add a fork-patch to extend `IShapeProperties` with `alpha`.

### P6. Page Setup has only 2 presets
- **File:** `PageSetupDialog.tsx:30–32`
- **Current:** Widescreen (16:9) and Standard (4:3).
- **Industry:** Google Slides ships **5 presets** (Standard 4:3, Widescreen 16:9, Widescreen 16:10, A4 portrait, A4 landscape, Custom). PowerPoint Online has even more.
- **Fix:** Add 16:10, A4 landscape, A4 portrait, US Letter landscape. ~10 lines in the presets array.

### P7. Theme picker is modal, not a popover anchored to the toolbar
- **File:** `ThemePicker.tsx:133` (backdrop + card)
- **Current:** Centered modal with backdrop.
- **Industry:** Google Slides' theme picker is an inline right-rail panel that slides in when you click the toolbar button. The deck stays visible behind it so users can preview themes against their actual content.
- **Fix:** Convert to a right-rail panel docked to the Format pane area. Live preview the theme against the active slide on hover (already supported via the cascade machinery). Bigger change — defer if scope is tight.

### P8. About dialog has no version number
- **File:** `apps/web/src/shell/AboutDialog.tsx:27–136`
- **Current:** Product name + tagline + license + repo + live demo URL + 7 dependency attributions.
- **Industry:** Every app shows its version. Some (PowerPoint Online) show build SHA.
- **Fix:** Add `version: 0.1.0` line. Read it from `import.meta.env.PACKAGE_VERSION` (Vite-defined) or hardcode to the value in `package.json`.

### P9. Properties dialog lacks created / modified / author metadata
- **File:** `PropertiesDialog.tsx:75–100+`
- **Current:** Title, slide count, page dimensions, element count, text character count. All useful but read like debug introspection.
- **Industry:** Properties dialogs in both Google Slides and PowerPoint Online lead with **Created · Modified · Author · Owner** dates. Element counts are way down the list.
- **Fix:** Read `coreProps` (already parsed in `pptx-import.ts` per the C19 work) and surface Created / Modified / Author at the top.

### P10. Recent files is local-only with no visual deck preview
- **File:** `apps/web/src/shell/RecentFilesDialog.tsx:38–100+`
- **Current:** Plain list — name, file size, relative time, pin / delete icons.
- **Industry:** Google Drive's recent files panel shows **thumbnail previews of the first slide**. PowerPoint Online does the same.
- **Fix:** Cache the first-slide PNG (or the SVG preview from the rail) at import time; render it as a 60 × 34 thumbnail next to each row. The data is available — `addRecent` already stores the .pptx blob.

---

## Cross-cutting themes

### Theme 1: Discovery vs power-user tradeoff
The Toolbar2 redesign **optimized for power users** (collapsed dropdowns reduce visual noise) at the cost of new-user discoverability. The fix is to add discoverability paths (top-level menus, inline status-bar shortcuts) **without removing** the power-user toolbar shape. Add, don't replace.

### Theme 2: Icons are uneven
- ✅ Toolbar has icons everywhere (good).
- ❌ Menu items have no icons.
- ❌ Format pane section headers have no icons (they read as text labels — `Position`, `Size`, `Fill`).
- ❌ Status bar has icons but they're undersized at 18 px.

Universal icon coverage at consistent 16–18 px would elevate the polish substantially. Use the existing `<Icon>` component — no new icons needed for menu coverage.

### Theme 3: Color hierarchy is inverted on the chrome
The brand teal is *very* prominent on the Slideshow CTA and the brand mark — but the visual weight of `Save` (more frequent action) is light by comparison. Industry: the **most-used button is the brightest**, not the least-used one. Google Slides puts no color on Slideshow; Save shows a green dot when changes are pending.

### Theme 4: First-impression naming
`Casual Slides — Spike A` as the default deck name leaks alpha-era branding. A v0.1.0 should default to `Untitled presentation`. Same for the first slide's content — "Casual Slides / PowerPoint-flavored web presentations" reads as marketing copy, not as content the user would author.

---

## Strengths (don't change these)

To balance the criticisms — what's already industry-quality:

1. **The shortcuts dialog (`Ctrl+/`)** — 7 sections, ~50 shortcuts, platform-aware modifiers (`⌘` on Mac). Few editors do this well. Notion-grade.
2. **The slide rail with real canvas thumbnails** — actual `SlideTile` rendering, not text snapshots. This is what Google Slides does and what PPTist *doesn't*.
3. **The Insert dropdown grid for shapes** — 15 shape glyphs in a 5-column grid (`Toolbar.tsx:416–698`). Cleaner than Google Slides' nested submenu.
4. **The presenter view layout** — two-pane current+next+notes+timer is the right shape. The B/W blackscreen toggle is a nice-to-have power feature.
5. **The brand mark itself** — clean hand-coded teal SVG, ~1.2 KB. Better proportions than PowerPoint's orange-red and more distinctive than Google's yellow.
6. **The Find & Replace popover stays anchored** while you interact with the canvas. Both Google and Microsoft block the canvas; this is genuinely better.
7. **Layout picker's Insert vs Apply mode toggle** — neither Google nor PowerPoint Online has this explicit toggle. The implicit "Insert in new slide" vs "Apply to current" ambiguity in those products causes user errors. Casual fixes that.

---

## Suggested order of operations for the parallel lane

If I were prioritizing my own time on the polish pass, in this order:

1. **S4** Fix the default deck title ("Untitled presentation") — 15 min, biggest first-impression win.
2. **S1** Add Format / Slide / Arrange menus to the menu strip — 1–2 h, biggest discoverability win.
3. **S2** Surface Theme / Background / Layout as inline toolbar buttons — 30 min, biggest "feels like Google Slides" win.
4. **S3** Move Present action to the status bar — 30 min, biggest "feels like the slideshow is one click away" win.
5. **S5** Add icons to all menu items — 1 h, biggest visual-density win.
6. **P3** Hover action overlays on slide rail thumbnails — 30 min, biggest "modern editor" feel win.
7. **P4** De-saturate the Slideshow CTA (or move it per S3) — 5 min.
8. **P8** Add `version: 0.1.0` to About dialog — 5 min.
9. **P9** Surface Created / Modified / Author in Properties — 30 min.
10. **P6** Add A4 / Letter / 16:10 presets to Page Setup — 15 min.

**Estimated total: 6–8 hours of focused work for the headline 10 items.** Items P5 (opacity) and P7 (theme picker → side panel) are larger; defer to a v0.2 polish sprint or the Univer fork-patch milestone.

---

## What I did NOT audit

- Accessibility deep dive (covered separately in the earlier Wave 0 audit and partially implemented).
- Mobile / tablet layout — the editor is desktop-only by design; no mobile audit performed.
- Internationalisation — only English shipped; the i18n shell is in place but no second locale to test.
- Localised conventions (date / time / number format) — none touched.

These are deliberate scope cuts. The user-facing UX gap is on desktop and in English, and that's where the polish wins are.

---

## Sign-off

The app is 70% of the way to "indistinguishable from Google Slides on first impression." The remaining 30% is **discoverability + visual hierarchy**, not feature parity. The list above gets you most of the way to industry-standard polish without touching any of the harder things (Univer fork patches, full Format pane rebuild, collab-correctness rework).

If the parallel UI/UX lane lands S1–S5 + P3–P4 + P8–P9, this audit's headline grade moves from `3.5 / 5` to `4.5 / 5` — close enough to Google Slides that the gap stops being the first thing a user notices.

— end of audit
