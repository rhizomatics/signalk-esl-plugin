import { readFile } from 'fs/promises';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import { Bitmap, Renderer, TemplateContext } from './types';
import { resolvePath } from './path';
import { Handlebars } from './helpers';

let wasmReady: Promise<void> | undefined;

function ensureWasmInitialized(): Promise<void> {
  if (!wasmReady) {
    wasmReady = readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm')).then((buffer) => initWasm(buffer));
  }
  return wasmReady;
}

/**
 * Renders an SVG+Handlebars template to a common RGBA bitmap.
 *
 * Binding model: any element with an `id` attribute has that id resolved as a
 * dotted path (supports array indices, e.g. "extremes.0.time") against the
 * supplied context. The resolved value is exposed as `value` alongside the
 * full context while rendering that element's text content as a Handlebars
 * template, so templates can use helpers like `{{truncate value 1}}` or
 * `{{formatTime value environment.time.timezoneRegion}}`.
 *
 * resvg-wasm cannot see the host's installed fonts (`loadSystemFonts`/`fontFiles`
 * are silently no-ops under plain Node) - it only renders text if given font
 * bytes directly via `fontBuffers`, read from disk by us. Without at least one
 * font path configured, all text elements render as nothing, with no error.
 */
export class SvgRenderer implements Renderer {
  private fontBuffers?: Promise<Uint8Array[]>;

  constructor(private readonly fontPaths: string[]) {
    if (fontPaths.length === 0) {
      throw new Error('SvgRenderer requires at least one font path - resvg-wasm cannot use host system fonts');
    }
  }

  private loadFontBuffers(): Promise<Uint8Array[]> {
    if (!this.fontBuffers) {
      this.fontBuffers = Promise.all(this.fontPaths.map(async (path) => new Uint8Array(await readFile(path))));
    }
    return this.fontBuffers;
  }

  async render(svgTemplatePath: string, context: TemplateContext, width: number, height: number): Promise<Bitmap> {
    const [, fontBuffers] = await Promise.all([ensureWasmInitialized(), this.loadFontBuffers()]);

    const svgSource = await readFile(svgTemplatePath, 'utf-8');
    const doc = new DOMParser().parseFromString(svgSource, 'image/svg+xml');
    const elements = doc.getElementsByTagName('*');

    for (let i = 0; i < elements.length; i++) {
      const element = elements.item(i);
      const id = element?.getAttribute('id');
      if (!element || !id) continue;

      const value = resolvePath(context, id);
      const template = element.textContent ?? '';
      element.textContent = Handlebars.compile(template)({ ...context, value });
    }

    const svgOutput = new XMLSerializer().serializeToString(doc);
    const resvg = new Resvg(svgOutput, {
      fitTo: { mode: 'width', value: width },
      font: { fontBuffers },
    });
    const rendered = resvg.render();

    if (rendered.width !== width || rendered.height !== height) {
      throw new Error(
        `rendered size ${rendered.width}x${rendered.height} does not match requested ${width}x${height} - check the template's width/height/viewBox`,
      );
    }

    return { width: rendered.width, height: rendered.height, data: rendered.pixels };
  }
}
