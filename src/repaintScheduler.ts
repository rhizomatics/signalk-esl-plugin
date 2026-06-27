import { createHash } from 'crypto';
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { ServerAPI, Path, SignalKResourceType } from '@signalk/server-api';
import { DeviceConfig, PluginConfig, parseDevice, resolveTemplatePath } from './config';
import { getDriver } from './devices/registry';
import { SvgRenderer } from './render/svgRenderer';
import { Binding, findBindings } from './render/binding';
import { TemplateContext } from './render/types';
import { fetchCategoryDisplayUnits } from './unitCategories';

const INTERVAL_POLL_MS = 60_000;
const SUBSCRIPTION_DEBOUNCE_MS = 2_000;

export interface RepaintScheduler {
  stop(): void;
}

type RepaintState = Record<string, { hash: string }>;

function statePath(app: ServerAPI): string {
  return join(app.getDataDirPath(), 'repaint-state.json');
}

function loadState(app: ServerAPI): RepaintState {
  try {
    return JSON.parse(readFileSync(statePath(app), 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(app: ServerAPI, state: RepaintState): void {
  writeFileSync(statePath(app), JSON.stringify(state));
}

/** Deterministic JSON serialisation (sorted keys) so re-ordered object keys don't change the hash. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashContext(context: TemplateContext): string {
  return createHash('sha1').update(stableStringify(context)).digest('hex');
}

/** Merges `value` into `target` at the nested location described by a dotted SignalK path. */
function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let node = target;
  for (const segment of segments.slice(0, -1)) {
    const next = node[segment];
    node[segment] = typeof next === 'object' && next !== null ? next : {};
    node = node[segment] as Record<string, unknown>;
  }
  node[segments[segments.length - 1]] = value;
}

/**
 * Reads live data for exactly what a template's own bindings ask for - no separate config declaring it.
 * `signalk`-sourced bindings are read directly (`self` via `getSelfPath`, anything else via `getPath`
 * against that literal SignalK context). `resources`-sourced bindings go through `app.resourcesApi` -
 * both in-process, like `getSelfPath`/`getPath`, so (unlike the CLI's HTTP-based equivalent in
 * `cli/liveContext.ts`) no URL is needed for either. An explicit `category=` binding is the one case
 * with no in-process equivalent - `apiUrl` is only needed for those (see `fetchCategoryDisplayUnits`).
 */
async function assembleRawContext(app: ServerAPI, apiUrl: string | undefined, bindings: Binding[]): Promise<TemplateContext> {
  const signalk: Record<string, unknown> = {};
  const seenSignalk = new Set<string>();
  for (const binding of bindings) {
    if (binding.source !== 'signalk') continue;
    const key = `${binding.context} ${binding.path}`;
    if (seenSignalk.has(key)) continue;
    seenSignalk.add(key);
    const value = binding.context === 'self' ? app.getSelfPath(binding.path) : app.getPath(`${binding.context}.${binding.path}`);
    const namespace = (signalk[binding.context] ??= {}) as Record<string, unknown>;
    setAtPath(namespace, binding.path, value);
  }
  signalk.self ??= {};

  const resources: Record<string, unknown> = {};
  const resourceNames = new Set(bindings.filter((binding) => binding.source === 'resources').map((binding) => binding.resource as string));
  for (const name of resourceNames) {
    // `listResources`'s type only allows the standard SignalKResourceType union, but the underlying
    // Resources API (and a custom provider like signalk-tides, registered under the non-standard
    // "tides" type) accepts any registered resource type string - this cast matches `getResource`'s
    // wider, accurate signature.
    resources[name] = await app.resourcesApi.listResources(name as SignalKResourceType, {});
  }

  const categoryNames = new Set(bindings.filter((binding) => binding.category).map((binding) => binding.category as string));
  if (categoryNames.size > 0 && !apiUrl) {
    throw new Error(`binding references categor${categoryNames.size > 1 ? 'ies' : 'y'} "${[...categoryNames].join(', ')}" but no SignalK API base URL is configured`);
  }
  const categories = apiUrl ? await fetchCategoryDisplayUnits(apiUrl, categoryNames) : {};

  return { signalk, resources, categories };
}

function clearForceRepaint(app: ServerAPI, friendlyName: string): void {
  const current = { ...(app.readPluginOptions() as Partial<PluginConfig>) };
  const devices = (current.devices ?? []).map((device) =>
    device.friendlyName === friendlyName ? { ...device, forceRepaint: false } : device,
  );
  app.savePluginOptions({ ...current, devices }, (err) => {
    if (err) app.debug(`failed to clear forceRepaint for "${friendlyName}": ${err.message}`);
  });
}

async function considerRepaint(app: ServerAPI, config: PluginConfig, device: DeviceConfig, state: RepaintState): Promise<void> {
  const model = parseDevice(device.device);
  const driver = model && getDriver(model.vendor);
  const metadata = model && driver?.metadataForPid(model.pid, model.hwVersion);
  if (!model || !driver || !metadata) {
    app.debug(`"${device.friendlyName}": no driver/metadata for device "${device.device}", skipping`);
    return;
  }
  const templatePath = resolveTemplatePath(config.templatesDir, device.templateName);
  const bindings = findBindings(readFileSync(templatePath, 'utf-8'));

  const rawContext = await assembleRawContext(app, config.signalkApiUrl, bindings);
  const hash = hashContext(rawContext);
  if (state[device.friendlyName]?.hash === hash && !device.forceRepaint) {
    app.debug(`"${device.friendlyName}": data unchanged, skipping repaint`);
    return;
  }

  const renderContext: TemplateContext = { ...rawContext, meta: { repaintedAt: new Date().toISOString() } };
  const renderer = new SvgRenderer();
  const bitmap = await renderer.render(templatePath, renderContext, metadata.width, metadata.height - metadata.voffset);
  await driver.paint(bitmap, { address: model.address, aesKey: device.aesKey });

  state[device.friendlyName] = { hash };
  saveState(app, state);
  if (device.forceRepaint) {
    clearForceRepaint(app, device.friendlyName);
  }
  app.debug(`"${device.friendlyName}": repainted`);
}

export function startRepaintScheduler(app: ServerAPI, config: PluginConfig): RepaintScheduler {
  const state = loadState(app);
  const unsubscribes: Array<() => void> = [];

  const repaint = (device: DeviceConfig) =>
    considerRepaint(app, config, device, state).catch((err) => app.debug(`"${device.friendlyName}": repaint failed: ${err.message}`));

  const intervalDevices = config.devices.filter((device) => device.repaintTrigger === 'interval');
  if (intervalDevices.length > 0) {
    const timer = setInterval(() => {
      const now = new Date();
      for (const device of intervalDevices) {
        const hours = device.intervalHours ?? 1;
        const minute = device.intervalMinute ?? 0;
        if (now.getHours() % hours === 0 && now.getMinutes() === minute) {
          repaint(device);
        }
      }
    }, INTERVAL_POLL_MS);
    unsubscribes.push(() => clearInterval(timer));
  }

  for (const device of config.devices) {
    if (device.repaintTrigger === 'subscription' && device.triggerPath) {
      const stream = app.streambundle.getSelfStream(device.triggerPath as Path).debounce(SUBSCRIPTION_DEBOUNCE_MS);
      const unsub = stream.onValue(() => repaint(device));
      unsubscribes.push(unsub);
    }
  }

  // Check every device once at startup - harmless given hash dedup, and covers newly-added
  // devices or a forceRepaint left set from before a restart.
  for (const device of config.devices) {
    repaint(device);
  }

  return {
    stop() {
      for (const unsubscribe of unsubscribes) unsubscribe();
    },
  };
}
