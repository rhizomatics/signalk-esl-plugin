import { readFile } from 'fs/promises';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import { Bitmap, Renderer, TemplateContext } from './types';
import { Handlebars } from './helpers';
import { DEFAULT_FONT_PATHS } from './fonts';

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
 * Binding model: a `<text>` element with a `<desc>` child has that child's
 * content compiled as a Handlebars template against the full context and
 * substituted in as the element's text, e.g.
 * `<desc>{{formatTime extremes.0.time environment.time.timezoneRegion}}</desc>`.
 * The `<text>` element's own visible content is left untouched in the source
 * file - it's just a placeholder so the template looks sane while laying it
 * out in an SVG editor - and is only overwritten in the in-memory copy used
 * for this render. `<text>` elements with no `<desc>` are left as static text.
 * Scoped to `<text>` rather than all elements with an id - setting `textContent`
 * on a structural element (e.g. the root `<svg>`) wipes its children, and
 * `getElementsByTagName` is a live NodeList, so that previously truncated the
 * whole tree and rendered blank.
 *
 * resvg-wasm cannot see the host's installed fonts (`loadSystemFonts`/`fontFiles`
 * are silently no-ops under plain Node) - it only renders text if given font
 * bytes directly via `fontBuffers`, read from disk by us. Without at least one
 * font path configured, all text elements render as nothing, with no error.
 * Defaults to the bundled monospace/sans-serif/serif trio (see ./fonts.ts) so
 * templates can use plain CSS generic font-family keywords.
 */
export class SvgRenderer implements Renderer {
  private fontBuffers?: Promise<Uint8Array[]>;

  constructor(private readonly fontPaths: string[] = DEFAULT_FONT_PATHS) {
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
    const elements = doc.getElementsByTagName('text');

    for (let i = 0; i < elements.length; i++) {
      const element = elements.item(i);
      if (!element) continue;

      const descElement = element.getElementsByTagName('desc').item(0);
      if (!descElement) continue;

      const expression = descElement.textContent ?? '';
      element.textContent = Handlebars.compile(expression)(context);
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
