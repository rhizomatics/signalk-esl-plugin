/**
 * One font per CSS generic family bucket (monospace/sans-serif/serif), bundled so rendering
 * doesn't depend on the host having any fonts installed - resvg-wasm cannot see host fonts at
 * all (see project memory). Must be .woff2 - resvg-wasm silently fails to render .woff.
 *
 * resvg-wasm does NOT route generic keywords (font-family:serif/sans-serif/monospace) to the
 * "right" loaded font by metadata - a generic keyword, or any font-family value that doesn't
 * exactly string-match a loaded font's own name, silently falls back to whichever loaded font
 * happens to work for the requested glyphs (in practice: array order). Templates may still use
 * the generic keywords (Inkscape's default) - svgRenderer.ts rewrites them to the matching
 * literal embedded name from GENERIC_FONT_FAMILY_MAP below before resvg ever sees the SVG - see
 * project memory. Keep this to one font per bucket rather than adding e.g. bold variants - there's
 * no reliable way to pick between two fonts sharing a literal name.
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

/**
 * Maps each CSS generic font-family keyword to the literal embedded name (nameID1) of the
 * bundled font that backs it in DEFAULT_FONT_PATHS above. svgRenderer.ts rewrites every
 * `font-family:sans-serif`/`serif`/`monospace` in a template to its literal name before handing
 * the SVG to resvg-wasm, since resvg-wasm does not route generic keywords to a loaded font itself
 * - see project memory. Keep these in sync with DEFAULT_FONT_PATHS if a bucket's font ever changes.
 */
export const GENERIC_FONT_FAMILY_MAP: Record<string, string> = {
  'sans-serif': 'Roboto',
  monospace: 'Roboto Mono',
  serif: 'Roboto Serif 20pt',
};
