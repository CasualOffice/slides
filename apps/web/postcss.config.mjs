// Consume the engine's shared PostCSS pipeline (tailwindcss + autoprefixer +
// postcss-preset-env + the --tw → --univer-tw scoping) so @univerjs/design's
// @tailwind source compiles when the engine is built from the submodule source.
export { default } from '@univerjs-infra/shared/postcss';
