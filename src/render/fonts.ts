/**
 * One font per CSS generic family bucket (monospace/sans-serif/serif), bundled so rendering
 * doesn't depend on the host having any fonts installed - resvg-wasm cannot see host fonts at
 * all (see project memory). Must be .woff2 - resvg-wasm silently fails to render .woff.
 * resvg auto-classifies each loaded font from its own metadata; there's no proven way to
 * control which one wins if two loaded fonts share a generic bucket, so keep this to one per
 * bucket rather than adding e.g. bold variants here.
 */
export const DEFAULT_FONT_PATHS: string[] = [
  require.resolve('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2'),
  require.resolve('@fontsource/roboto/files/roboto-latin-400-normal.woff2'),
  require.resolve('@fontsource/playfair-display/files/playfair-display-latin-400-normal.woff2'),
];
