import { DOMParser } from '@xmldom/xmldom';
import { TemplateContext } from './types';
import { applyFormat, DisplayUnits, formatDisplayUnits } from './formatters';

const SOURCES = ['signalk', 'resources'] as const;
type Source = (typeof SOURCES)[number];

/**
 * Parsed form of a `<desc>`'s `key=value,key=value` content - see `parseBinding` for the grammar.
 */
export interface Binding {
  source: Source;
  /** `'self'` (default) or any other literal SignalK context as shown in the Data Browser, e.g. `vessels.urn:mrn:imo:mmsi:232345678`. */
  context: string;
  /** Required when `source === 'resources'` - the Resources API resource type, e.g. `tides`, `waypoints`. */
  resource?: string;
  path: string;
  /** A named formatter (see `./formatters.ts`), or `'raw'` to suppress metadata-driven auto unit-conversion (see `renderBinding`). */
  format?: string;
  round?: number;
}

const KNOWN_KEYS = new Set(['source', 'context', 'resource', 'path', 'format', 'round']);

/**
 * Parses a `<desc>` element's text content into a `Binding`, e.g.
 * `source=resources,resource=tides,path=extremes.[0].level,format=depth,round=2` or, using the
 * defaults (`source=signalk,context=self`), plain `path=navigation.speedOverGround,format=speed`.
 * A bare path with no `key=value` pairs at all, e.g. `environment.forecast.description`, is shorthand
 * for `path=environment.forecast.description` (source/context still default to signalk/self) - SignalK
 * paths never contain `=`, so its absence unambiguously signals this shorthand.
 */
export function parseBinding(desc: string): Binding {
  const trimmedDesc = desc.trim();
  if (trimmedDesc && !trimmedDesc.includes('=')) {
    return { source: 'signalk', context: 'self', path: trimmedDesc };
  }

  const fields: Record<string, string> = {};
  for (const pair of desc.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) {
      throw new Error(`invalid binding "${desc}" - expected "key=value" pairs, got "${trimmed}"`);
    }
    const key = trimmed.slice(0, eq).trim();
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`invalid binding "${desc}" - unknown key "${key}"`);
    }
    fields[key] = trimmed.slice(eq + 1).trim();
  }

  const source = (fields.source ?? 'signalk') as Source;
  if (!SOURCES.includes(source)) {
    throw new Error(`invalid binding "${desc}" - unknown source "${source}"`);
  }
  const context = fields.context ?? 'self';
  if (source === 'resources' && !fields.resource) {
    throw new Error(`invalid binding "${desc}" - source=resources requires a "resource" key`);
  }
  if (!fields.path) {
    throw new Error(`invalid binding "${desc}" - missing required "path" key`);
  }

  return {
    source,
    context,
    resource: fields.resource,
    path: fields.path,
    format: fields.format,
    round: fields.round !== undefined ? Number(fields.round) : undefined,
  };
}

/**
 * Parses every `<text>` element's `<desc>` binding out of raw SVG source - lets a caller discover what
 * data a template needs before fetching anything, with no separate config declaring it (see
 * `assembleRawContext` in repaintScheduler.ts).
 */
export function findBindings(svgSource: string): Binding[] {
  const doc = new DOMParser().parseFromString(svgSource, 'image/svg+xml');
  const elements = doc.getElementsByTagName('text');
  const bindings: Binding[] = [];
  for (let i = 0; i < elements.length; i++) {
    const desc = elements.item(i)?.getElementsByTagName('desc').item(0);
    if (desc?.textContent) {
      bindings.push(parseBinding(desc.textContent));
    }
  }
  return bindings;
}

/** Supports both `a.[0].b` and `a[0].b` array index notation, matching `setAtPath` in repaintScheduler.ts. */
function getAtPath(obj: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment) => segment.length > 0);
  let node: unknown = obj;
  for (const segment of segments) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Resolves a parsed `Binding` against the render context assembled by `assembleRawContext`. */
export function resolveBinding(binding: Binding, context: TemplateContext): unknown {
  if (binding.source === 'signalk') {
    const signalk = context.signalk as Record<string, unknown> | undefined;
    const vessel = signalk?.[binding.context];
    if (vessel === undefined) {
      throw new Error(`binding references context "${binding.context}" which is not present in the render context`);
    }
    return getAtPath(vessel, binding.path);
  }

  const resources = context.resources as Record<string, unknown> | undefined;
  const resource = resources?.[binding.resource as string];
  if (resource === undefined) {
    throw new Error(`binding references resource "${binding.resource}" which is not present in the render context`);
  }
  return getAtPath(resource, binding.path);
}

/**
 * Looks up a `signalk`-sourced binding's path in `context.meta` (mirrors `context.signalk`'s shape -
 * see `assembleRawContext` in repaintScheduler.ts / `assembleLiveContext` in cli/liveContext.ts).
 * Unlike `resolveBinding`, never throws - metadata is always best-effort (a `source=resources` binding,
 * an older server with no `/meta` endpoint, or simply a path with no metadata registered all resolve
 * to "no metadata" rather than an error).
 */
function resolveDisplayUnits(binding: Binding, context: TemplateContext): DisplayUnits | undefined {
  if (binding.source !== 'signalk') return undefined;
  const meta = context.meta as Record<string, unknown> | undefined;
  const vessel = meta?.[binding.context];
  if (vessel === undefined) return undefined;
  const metadata = getAtPath(vessel, binding.path) as { displayUnits?: DisplayUnits } | undefined;
  return metadata?.displayUnits;
}

/**
 * Resolves a binding and renders it to text exactly as `SvgRenderer` does for a `<desc>` - shared so
 * the CLI's `field`/`fields` commands show the same thing a real render would.
 *
 * A numeric `signalk`-sourced value auto-converts to its path's preferred display unit (from
 * `context.meta`) by default - `format=raw` opts out. An explicit named `format=` (anything other
 * than `raw`) always takes precedence. Resource-sourced numbers have no per-path metadata, so they
 * always show the raw value (still subject to `round=`).
 *
 * Falls back to `JSON.stringify` for an unformatted object/array value (e.g. a path that resolved to a
 * whole sub-tree rather than a leaf) instead of the useless `String(value)` -> `"[object Object]"`.
 */
export function renderBinding(binding: Binding, context: TemplateContext): string {
  const value = resolveBinding(binding, context);
  if (binding.format && binding.format !== 'raw') return applyFormat(binding.format, value, context, binding.round);
  if (typeof value === 'number') {
    const displayUnits = binding.format === 'raw' ? undefined : resolveDisplayUnits(binding, context);
    if (displayUnits) return formatDisplayUnits(value, displayUnits, binding.round);
    if (binding.round !== undefined) return value.toFixed(binding.round);
  }
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
