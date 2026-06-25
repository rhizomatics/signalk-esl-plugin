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

/** Arbitrary data made available to a template's Handlebars expressions. */
export type TemplateContext = Record<string, unknown>;

export interface Renderer {
  render(svgTemplatePath: string, context: TemplateContext, width: number, height: number): Promise<Bitmap>;
}
