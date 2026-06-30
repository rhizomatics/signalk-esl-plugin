import { readFile } from 'fs/promises';
import path from 'path';
import { Binding } from '../render/binding';
import { DisplayUnits, resolveLocalZoneAbbreviation } from '../render/formatters';
import { TemplateContext } from '../render/types';
import { fetchJson } from '../httpJson';
import { fetchCategoryDisplayUnits } from '../unitCategories';
import { fetchPathMeta } from '../pathMeta';
import { logDebug } from './log';

const RESOURCES_API_PATH = '/signalk/v2/api/resources';

/** `context=self` -> `vessels/self`, `context=vessels.urn:mrn:imo:mmsi:1` -> `vessels/urn:mrn:imo:mmsi:1` - matches the REST path for that context's full-data-model subtree. */
function contextPath(context: string): string {
  return context === 'self' ? 'vessels/self' : context.replace(/\./g, '/');
}

/**
 * `GET .../vessels/self` (or any other subtree) returns SignalK's full delta-tree shape, where every
 * leaf is wrapped as `{ value, $source, timestamp, ... }` rather than the bare value - unlike
 * `app.getSelfPath`/`getPath` in the live plugin (repaintScheduler.ts), which already return bare
 * values. Recursively unwraps every such leaf so `path=` bindings resolve the same way over HTTP as
 * they do live. Only applied to `signalk` fetches - `resources` responses have no such wrapper.
 *
 * Keys off `value` alone, not also requiring `timestamp`/`$source` - not every server includes both on
 * every leaf, and a `value` key is otherwise meaningless on a SignalK data-model node (it isn't a
 * regular vessel property name), so there's no real risk of unwrapping something that isn't this
 * wrapper.
 */
function unwrapSignalkTree(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(unwrapSignalkTree);
  const obj = node as Record<string, unknown>;
  if ('value' in obj) {
    return obj.value;
  }
  return Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, unwrapSignalkTree(value)]));
}

/**
 * CLI counterpart to `assembleRawContext` + `considerRepaint`'s `meta` injection in
 * repaintScheduler.ts - same `{ signalk, resources, pathMeta, categories, meta }` shape, but fetched
 * entirely over plain HTTP (the CLI has no live `ServerAPI` to call `getSelfPath`/`getPath`/
 * `resourcesApi` on, and per-path metadata/`category=` resolution has no in-process equivalent at all
 * - see `repaintScheduler.ts`) against a real or test SignalK server's REST API. Fetches each
 * referenced context's/resource's *whole* subtree once and lets the existing binding resolver
 * navigate `path` within it.
 */
export async function assembleLiveContext(signalkUrl: string, bindings: Binding[]): Promise<TemplateContext> {
  const signalk: Record<string, unknown> = {};
  const contexts = new Set(bindings.filter((binding) => binding.source === 'signalk').map((binding) => binding.context));
  for (const context of contexts) {
    const url = `${signalkUrl}/signalk/v1/api/${contextPath(context)}`;
    logDebug(`GET ${url}`);
    signalk[context] = unwrapSignalkTree(await fetchJson(url));
  }

  const pathMeta: Record<string, unknown> = {};
  for (const context of contexts) {
    try {
      logDebug(`GET ${signalkUrl}/signalk/v1/api/${contextPath(context)}/meta`);
      pathMeta[context] = await fetchPathMeta(signalkUrl, context);
    } catch (err) {
      console.error(`warning: could not fetch path metadata for context "${context}" (${(err as Error).message}) - automatic unit conversion will show raw values`);
    }
  }

  const resources: Record<string, unknown> = {};
  const resourceNames = new Set(bindings.filter((binding) => binding.source === 'resources').map((binding) => binding.resource as string));
  for (const name of resourceNames) {
    const url = `${signalkUrl}${RESOURCES_API_PATH}/${name}`;
    logDebug(`GET ${url}`);
    resources[name] = await fetchJson(url);
  }

  const categoryNames = new Set(bindings.filter((binding) => binding.category).map((binding) => binding.category as string));
  const categories = await fetchCategoryDisplayUnits(signalkUrl, categoryNames);

  // Matches `considerRepaint` in repaintScheduler.ts - the CLI has no real device repaint to time, so
  // a `source=einklabel,path=repainted` binding just resolves to "now", same as a live render would.
  const meta = { repainted: new Date().toISOString(), local_zone: resolveLocalZoneAbbreviation({ signalk }) };

  return { signalk, resources, pathMeta, categories, meta };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`could not read example data file ${filePath} - ${(err as Error).message}`);
  }
  return JSON.parse(raw);
}

/**
 * `-e/--example-data` counterpart to `assembleLiveContext`, for previewing a template with no SignalK
 * server at all. Reads the same `{ signalk, resources, categories }` shapes a real server would
 * return, but from static JSON files under `examplesDir`:
 * - `<examplesDir>/vessels.json` - the full data model (`{ "vessels": { "self": {...}, ... } }`,
 *   delta-tree leaves wrapped as `{ value, ... }` exactly like the REST API - see `unwrapSignalkTree`),
 *   sliced down to whichever `context=` subtree each `source=signalk` binding needs.
 * - `<examplesDir>/resources/<name>.json` - one file per `resource=<name>`, holding that resource's
 *   data directly (no wrapper), matching the Resources API's response shape.
 * - `<examplesDir>/categories.json` - a flat `{ "<category>": DisplayUnits, ... }` map, standing in for
 *   what `fetchCategoryDisplayUnits` would otherwise resolve from a server's unit-preferences config
 *   (categoryToBaseUnit + active preset + conversion definitions - no static-file equivalent for that
 *   3-way join, so this file holds the already-resolved result directly).
 *
 * `pathMeta` has no static-file equivalent (it's live server-side config - see `fetchPathMeta`), so
 * it's left empty: automatic unit conversion falls back to a path's `category=` binding if it has one,
 * or shows the raw value otherwise.
 */
export async function assembleExampleContext(examplesDir: string, bindings: Binding[]): Promise<TemplateContext> {
  const signalk: Record<string, unknown> = {};
  const contexts = new Set(bindings.filter((binding) => binding.source === 'signalk').map((binding) => binding.context));
  if (contexts.size > 0) {
    const vesselsPath = path.join(examplesDir, 'vessels.json');
    logDebug(`reading ${vesselsPath}`);
    const vessels = await readJsonFile(vesselsPath);
    for (const context of contexts) {
      const segments = contextPath(context).split('/');
      let node: unknown = vessels;
      for (const segment of segments) {
        node = node === null || typeof node !== 'object' ? undefined : (node as Record<string, unknown>)[segment];
      }
      if (node === undefined) {
        throw new Error(`example data file ${vesselsPath} has no "${segments.join('.')}" subtree for context "${context}"`);
      }
      signalk[context] = unwrapSignalkTree(node);
    }
  }

  const resources: Record<string, unknown> = {};
  const resourceNames = new Set(bindings.filter((binding) => binding.source === 'resources').map((binding) => binding.resource as string));
  for (const name of resourceNames) {
    const resourcePath = path.join(examplesDir, 'resources', `${name}.json`);
    logDebug(`reading ${resourcePath}`);
    resources[name] = await readJsonFile(resourcePath);
  }

  const categoryNames = new Set(bindings.filter((binding) => binding.category).map((binding) => binding.category as string));
  let categories: Record<string, DisplayUnits> = {};
  if (categoryNames.size > 0) {
    const categoriesPath = path.join(examplesDir, 'categories.json');
    logDebug(`reading ${categoriesPath}`);
    categories = (await readJsonFile(categoriesPath)) as Record<string, DisplayUnits>;
    for (const category of categoryNames) {
      if (!(category in categories)) {
        throw new Error(`example data file ${categoriesPath} has no "${category}" entry`);
      }
    }
  }

  const meta = { repainted: new Date().toISOString(), local_zone: resolveLocalZoneAbbreviation({ signalk }) };

  return { signalk, resources, pathMeta: {}, categories, meta };
}
