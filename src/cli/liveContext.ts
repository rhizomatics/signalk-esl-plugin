import { Binding } from '../render/binding';
import { TemplateContext } from '../render/types';
import { fetchJson } from '../httpJson';
import { fetchCategoryDisplayUnits } from '../unitCategories';
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
 * CLI counterpart to `assembleRawContext` in repaintScheduler.ts - same `{ signalk, resources,
 * categories }` shape, but fetched entirely over plain HTTP (the CLI has no live `ServerAPI` to call
 * `getSelfPath`/`getPath`/`resourcesApi` on) against a real or test SignalK server's REST API. Fetches
 * each referenced context's/resource's *whole* subtree once and lets the existing binding resolver
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

  const resources: Record<string, unknown> = {};
  const resourceNames = new Set(bindings.filter((binding) => binding.source === 'resources').map((binding) => binding.resource as string));
  for (const name of resourceNames) {
    const url = `${signalkUrl}${RESOURCES_API_PATH}/${name}`;
    logDebug(`GET ${url}`);
    resources[name] = await fetchJson(url);
  }

  const categoryNames = new Set(bindings.filter((binding) => binding.category).map((binding) => binding.category as string));
  const categories = await fetchCategoryDisplayUnits(signalkUrl, categoryNames);

  return { signalk, resources, categories };
}
