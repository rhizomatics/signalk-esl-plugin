/**
 * Common raster output produced by the SVG renderer, before any
 * vendor-specific colour quantisation or bit-packing is applied.
 */
export interface Bitmap {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major, top-left origin */
  data: Uint8Array;
}

/**
 * Render context a template's `<desc>` bindings resolve against - see `./binding.ts`. Shaped as
 * `{ signalk: { self: {...}, [vesselContext]: {...} }, resources: { [resourceName]: ... },
 * categories: { [categoryName]: DisplayUnits } }` by `assembleRawContext` in repaintScheduler.ts,
 * fetched fresh from a template's own bindings every repaint - no separate config declares what a
 * template needs. `categories` backs an explicit `category=` binding (see `../unitCategories.ts`).
 * `meta` (unrelated, plugin-injected) holds the repaint timestamp - see `considerRepaint`.
 */
export type TemplateContext = Record<string, unknown>;

export interface Renderer {
  render(svgTemplatePath: string, context: TemplateContext, width: number, height: number): Promise<Bitmap>;
}
