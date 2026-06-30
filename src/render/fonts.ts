/**
 * One font per CSS generic family bucket (monospace/sans-serif/serif), bundled so rendering
 * doesn't depend on the host having any fonts installed - resvg-wasm cannot see host fonts at
 * all (see project memory). Must be .woff2 - resvg-wasm silently fails to render .woff.
 *
 * resvg-wasm does NOT route generic keywords (font-family:serif/sans-serif/monospace) to the
 * "right" loaded font by metadata - a generic keyword, or any font-family value that doesn't
 * exactly string-match a loaded font's own name, silently falls back to whichever loaded font
 * happens to work for the requested glyphs (in practice: array order). Templates MUST reference
 * each font by its exact embedded family name (e.g. `font-family:'Roboto Mono'` in the SVG's
 * style=, not the bare `serif`/`monospace` keyword) for resvg to actually pick it - see
 * templates/tide.svg and project memory. Keep this to one font per bucket rather than adding
 * e.g. bold variants - there's no reliable way to pick between two fonts sharing a literal name.
 *
 * Must be the static (non-variable) @fontsource builds, not @fontsource-variable - every
 * @fontsource-variable/roboto-{mono,serif} subset renders zero visible glyphs under resvg-wasm
 * (loads without error, but produces a blank image - confirmed by counting non-white output
 * pixels), and every @fontsource-variable/roboto-flex subset crashes resvg-wasm's font parser
 * outright with a WASM "unreachable" trap (a Rust panic) - see project memory. The static Roboto
 * Mono/Serif builds used here render correctly and keep the whole set in the Roboto super-family.
 */
export const DEFAULT_FONT_PATHS: string[] = [
  // first font is the default
  require.resolve('@fontsource/roboto/files/roboto-latin-400-normal.woff2'),
  require.resolve('@fontsource/roboto-mono/files/roboto-mono-latin-400-normal.woff2'),
  require.resolve('@fontsource/roboto-serif/files/roboto-serif-latin-400-normal.woff2'),
];
