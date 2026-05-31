/// <reference types="vite/client" />

declare module '*.css';

// Compile-time constants injected via vite.config.ts `define`. Listed
// here so callers get type-checked references and the IDE can autocomplete.
declare const __APP_VERSION__: string;

// Build-time env contract. Keep narrow — every flag here imposes a
// surface area that must be honoured at runtime, so add deliberately.
interface ImportMetaEnv {
  // Whether real-time collab is enabled in this build. When 'false' (the
  // default) the CollabProvider refuses to honour `?room=…` URLs even
  // if the user supplies one — this gates the 7 known TODO(collab)
  // editing paths that bypass the command bus and would silently
  // desync concurrent edits in a shared room. Flip to 'true' once the
  // fork-side `slide.mutation.*` patches land. See
  // docs/UI_UX_TRACKER.md → Wave 0 "Not yet" and
  // docs/UNIVER_SLIDES_GAPS.md → Gap 1.4.
  readonly VITE_COLLAB_ENABLED?: 'true' | 'false';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
