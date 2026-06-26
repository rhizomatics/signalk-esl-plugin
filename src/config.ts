import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { ServerAPI } from '@signalk/server-api';
import { allDrivers } from './devices/registry';
import { DiscoveredDevice } from './devices/types';

/** Binds an HTTP(S) JSON endpoint (a built-in SignalK API or a plugin-provided one, e.g. signalk-tides) into the render context. */
export interface ProviderBinding {
  url: string;
  /** Namespace to merge the response under; omit to merge at the context root (matches how the bundled tide template expects its data). */
  contextKey?: string;
}

/** A reusable named bundle of data sources that one or more devices can render their template against. */
export interface ContextConfig {
  id: string;
  /** Dotted SignalK paths read via `getSelfPath` and merged into the render context preserving their natural nesting. */
  signalkPaths: string[];
  providers: ProviderBinding[];
}

export interface DeviceConfig {
  friendlyName: string;
  /**
   * `"<vendor>:<pid>[:<hwVersion>]@<address>"`, picked from a combined enum of recently
   * scanned devices so one selection sets both the model (width/height/colours, known
   * without a live BLE read) and the BLE address.
   */
  device: string;
  /** Per-device override; if omitted, the vendor driver may fall back to a stock/manufacturer-default key. */
  aesKey?: string;
  templateName: string;
  /** References a `ContextConfig.id` - the data this device's template is rendered against. */
  contextId: string;
  repaintTrigger: 'subscription' | 'interval';
  /** SignalK path to subscribe to when `repaintTrigger` is `subscription` - a repaint is considered on every delta. */
  triggerPath?: string;
  /** When `repaintTrigger` is `interval`: repaint every N hours... */
  intervalHours?: number;
  /** ...at this minute past the hour. */
  intervalMinute?: number;
  /** One-shot override to repaint even if the data is unchanged; cleared automatically once that repaint completes. */
  forceRepaint?: boolean;
}

export interface PluginConfig {
  /** Directory the plugin scans for template files, instead of an upload UI. */
  templatesDir: string;
  /** Run a short BLE scan on plugin start and report discoveries via plugin status, like signalk-bluetti-plugin does. */
  scanOnStart: boolean;
  /** How long the startup scan runs, in seconds. */
  scanDurationSeconds: number;
  contexts: ContextConfig[];
  devices: DeviceConfig[];
}

/** The package's own bundled `templates/` directory (ships alongside `dist/`, see package.json's `files`) - templates here are always available, but a same-named template in the user's `templatesDir` takes priority. */
const BUNDLED_TEMPLATES_DIR = join(__dirname, '..', 'templates');

/** Defaults that need `app` to compute (the templates dir lives under the SignalK config directory, not this package's install location). */
export function defaultConfig(app: ServerAPI): PluginConfig {
  return {
    templatesDir: join(app.getDataDirPath(), 'templates'),
    scanOnStart: true,
    scanDurationSeconds: 15,
    contexts: [],
    devices: [],
  };
}

/**
 * Enum for the combined "device" field, built from recently scanned devices (only ones a
 * registered driver actually recognised - an unrecognised model can't be painted) plus,
 * as a fallback, whatever's already saved so an existing selection doesn't vanish from the
 * dropdown just because this particular run hasn't re-scanned it yet.
 */
function deviceOptions(discovered: DiscoveredDevice[], current: PluginConfig): { values: string[]; labels: string[] } {
  const values: string[] = [];
  const labels: string[] = [];
  const seen = new Set<string>();

  for (const found of discovered) {
    if (!found.metadata) {
      continue;
    }
    const modelToken = [found.vendor, found.pid, found.metadata.hwVersion].filter((part) => part !== undefined).join(':');
    const value = `${modelToken}@${found.address}`;
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
    labels.push(`${found.vendor} ${found.metadata.label} (${found.address})`);
  }

  for (const device of current.devices) {
    if (!seen.has(device.device)) {
      seen.add(device.device);
      values.push(device.device);
      labels.push(`${device.device} (not seen in last scan)`);
    }
  }

  return { values, labels };
}

export function parseDevice(device: string): { vendor: string; pid: number; hwVersion?: string; address: string } | undefined {
  const [modelToken, address] = device.split('@');
  const [vendor, pidStr, hwVersion] = (modelToken ?? '').split(':');
  const pid = Number(pidStr);
  return vendor && address && Number.isInteger(pid) ? { vendor, pid, hwVersion, address } : undefined;
}

function listSvgFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.svg'));
  } catch {
    return [];
  }
}

/** Local templates take priority over a same-named bundled one; both show up as options. */
function templateNameOptions(templatesDir: string): string[] {
  const local = listSvgFiles(templatesDir);
  const bundled = listSvgFiles(BUNDLED_TEMPLATES_DIR).filter((name) => !local.includes(name));
  return [...local, ...bundled];
}

/** Resolves a template name to an actual file path - a local template overrides the bundled one of the same name. */
export function resolveTemplatePath(templatesDir: string, templateName: string): string {
  const localPath = join(templatesDir, templateName);
  return existsSync(localPath) ? localPath : join(BUNDLED_TEMPLATES_DIR, templateName);
}

/** JSON Schema forbids an empty `enum` array, so only attach one when there's at least one option - otherwise the whole config schema fails validation. */
function withEnum<T extends object>(schema: T, values: string[], names?: string[]): T & { enum?: string[]; enumNames?: string[] } {
  return values.length > 0 ? { ...schema, enum: values, ...(names ? { enumNames: names } : {}) } : schema;
}

export function configSchema(app: ServerAPI, discovered: DiscoveredDevice[] = []): object {
  const defaults = defaultConfig(app);
  const current = { ...defaults, ...(app.readPluginOptions() as Partial<PluginConfig>) };
  const { values: deviceValues, labels: deviceLabels } = deviceOptions(discovered, current);
  const contextIds = current.contexts.map((context) => context.id);

  return {
    type: 'object',
    properties: {
      templatesDir: {
        type: 'string',
        title: 'Templates directory',
        description: 'Directory to search for local SVG/Handlebars template files - a template here with the same name as a bundled one takes priority.',
        default: defaults.templatesDir,
      },
      scanOnStart: {
        type: 'boolean',
        title: 'Scan for devices on plugin start',
        description: 'Runs a short BLE scan so discovered devices show up in a device\'s "Device" picker below.',
        default: defaults.scanOnStart,
      },
      scanDurationSeconds: {
        type: 'number',
        title: 'Scan duration (seconds)',
        description: 'How long the startup scan runs - increase if devices are missing from the "Device" picker below.',
        minimum: 1,
        default: defaults.scanDurationSeconds,
      },
      contexts: {
        type: 'array',
        title: 'Contexts',
        description: 'Reusable named bundles of data (SignalK paths + API providers) that one or more devices render their template against.',
        items: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', title: 'Context ID' },
            signalkPaths: {
              type: 'array',
              title: 'SignalK Paths',
              description: 'Dotted paths to read and merge into the template context, e.g. environment.time.timezoneRegion',
              items: { type: 'string' },
            },
            providers: {
              type: 'array',
              title: 'API providers',
              description: 'HTTP(S) JSON endpoints to merge into the template context - a built-in SignalK API or a plugin-provided one (e.g. signalk-tides)',
              items: {
                type: 'object',
                required: ['url'],
                properties: {
                  url: { type: 'string', title: 'URL' },
                  contextKey: { type: 'string', title: 'Context key (optional - merges at the root if left blank)' },
                },
              },
            },
          },
        },
      },
      devices: {
        type: 'array',
        title: 'Devices',
        items: {
          type: 'object',
          required: ['friendlyName', 'device', 'templateName', 'contextId', 'repaintTrigger'],
          properties: {
            friendlyName: { type: 'string', title: 'Friendly name' },
            device: withEnum(
              {
                type: 'string',
                title: 'Device',
                description: 'Picked from devices found by a scan (plugin start, or `esl-cli scan`) - sets both the model and BLE address.',
              },
              deviceValues,
              deviceLabels,
            ),
          
            templateName: withEnum({ type: 'string', title: 'Template' }, templateNameOptions(current.templatesDir)),
            contextId: withEnum({ type: 'string', title: 'Context' }, contextIds),
            repaintTrigger: { type: 'string', title: 'Repaint trigger', enum: ['subscription', 'interval'] },
            triggerPath: { type: 'string', title: 'Trigger SignalK path (if repaint trigger is subscription)' },
            intervalHours: { type: 'number', title: 'Repaint every N hours (if repaint trigger is interval)', minimum: 1 },
            intervalMinute: { type: 'number', title: 'Minutes past the hour (if repaint trigger is interval)', minimum: 0, maximum: 59, default: 0 },
            aesKey: { type: 'string', title: 'BLE AES key (vendor-specific; leave blank to use a default key)' },
            forceRepaint: {
              type: 'boolean',
              title: 'Force repaint',
              description: 'Repaint even if the data is unchanged - clears itself automatically once that repaint completes',
              default: false,
            },
          },
        },
      },
    },
  };
}

export function configUiSchema(): object {
  return {
    devices: {
      items: {
        repaintTrigger: { 'ui:widget': 'radio' },
      },
    },
  };
}
