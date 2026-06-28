import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join } from 'path';
import { ServerAPI } from '@signalk/server-api';
import { allDrivers } from './devices/registry';
import { DiscoveredDevice } from './devices/types';
import { SIGNALK_API_URL_OPTIONS } from './resolveApiUrl';

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
  /**
   * Directory the plugin scans for template files, instead of an upload UI - follows
   * signalk-parquet's convention: empty for the default, a relative path resolved against
   * `~/.signalk`, or an absolute path. Use `resolveTemplatesDir` to turn this into an actual path.
   */
  templatesDir: string;
  /** Run a short BLE scan on plugin start and report discoveries via plugin status, like signalk-bluetti-plugin does. */
  scanOnStart: boolean;
  /** How long the startup scan runs, in seconds. */
  scanDurationSeconds: number;
  /** How long to wait for a device to accept a BLE connection before giving up on a repaint attempt, in seconds. */
  paintConnectTimeoutSeconds: number;
  /** How many times to attempt a repaint (including the first try) before giving up and reporting failure. */
  paintRetries: number;
  /**
   * Base URL of this SignalK server, used for: (1) a `signalk`-sourced numeric value's automatic unit
   * conversion (`GET .../vessels/<context>/meta`, see `../pathMeta.ts`) unless `format=raw`, and (2) an
   * explicit `category=` binding (e.g. `category=depth` on a resource-sourced value with no path
   * metadata of its own, see `../unitCategories.ts`). Neither has an in-process equivalent reachable via
   * the plugin API - confirmed against the signalk-server source, this resolution only happens in its
   * REST layer.
   *
   * Always the local loopback address - the plugin runs on the same host as the server, so it's
   * reachable regardless of any external reverse proxy. Left unset, the plugin probes
   * `SIGNALK_API_URL_OPTIONS` at startup (in likelihood order: 3000 for a bare `npm install`, then
   * 80/443 for container/systemd installs) and uses whichever responds - see `./resolveApiUrl.ts`. Set
   * explicitly only to skip probing or to confirm a specific one is reachable; either way, it must allow
   * anonymous read access - the plugin has no login flow.
   */
  signalkApiUrl?: string;
  devices: DeviceConfig[];
}

/** The package's own bundled `templates/` directory (ships alongside `dist/`, see package.json's `files`) - templates here are always available, but a same-named template in the user's `templatesDir` takes priority. */
const BUNDLED_TEMPLATES_DIR = join(__dirname, '..', 'templates');

const SIGNALK_HOME_DIR = join(homedir(), '.signalk');
const DEFAULT_TEMPLATES_DIR = join(SIGNALK_HOME_DIR, 'esl', 'templates');

export function defaultConfig(): PluginConfig {
  return {
    templatesDir: '',
    scanOnStart: true,
    scanDurationSeconds: 20,
    paintConnectTimeoutSeconds: 30,
    paintRetries: 3,
    devices: [],
  };
}

/**
 * Resolves the user-facing `templatesDir` setting to an actual directory, mirroring
 * signalk-parquet's `outputDirectory` convention: empty means the default location, a relative
 * path is resolved against `~/.signalk` (where SignalK itself stores its config by default), and
 * an absolute path is used as-is.
 */
export function resolveTemplatesDir(templatesDir: string | undefined): string {
  const trimmed = templatesDir?.trim();
  if (!trimmed) {
    return DEFAULT_TEMPLATES_DIR;
  }
  return isAbsolute(trimmed) ? trimmed : join(SIGNALK_HOME_DIR, trimmed);
}

/**
 * Enum for the combined "device" field, built from recently scanned devices - including ones a
 * driver identified as its vendor but whose PID isn't in its metadata table yet (clearly labelled,
 * so the user can at least see what was found and report the PID; repainting such a device still
 * does nothing without a model override, since there's no width/height to render with) - plus, as a
 * fallback, whatever's already saved so an existing selection doesn't vanish from the dropdown just
 * because this particular run hasn't re-scanned it yet.
 */
function deviceOptions(discovered: DiscoveredDevice[], current: PluginConfig): { values: string[]; labels: string[] } {
  const values: string[] = [];
  const labels: string[] = [];
  const seen = new Set<string>();

  for (const found of discovered) {
    if (found.pid === undefined) {
      continue;
    }
    const modelToken = [found.vendor, found.pid, found.hwVersion].filter((part) => part !== undefined).join(':');
    const value = `${modelToken}@${found.address}`;
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
    const label = found.metadata
      ? `${found.vendor} ${found.metadata.label} (${found.address})`
      : `${found.vendor} unrecognised PID 0x${found.pid.toString(16).padStart(4, '0')} (${found.address})`;
    labels.push(label);
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
  const defaults = defaultConfig();
  const current = { ...defaults, ...(app.readPluginOptions() as Partial<PluginConfig>) };
  const { values: deviceValues, labels: deviceLabels } = deviceOptions(discovered, current);

  return {
    type: 'object',
    properties: {
      templatesDir: {
        type: 'string',
        title: 'Templates directory',
        description:
          `Relative path from ~/.signalk (e.g., "esl/templates" becomes ~/.signalk/esl/templates). ` +
          `Leave empty for default (${DEFAULT_TEMPLATES_DIR}). Absolute paths also supported. A template here ` +
          'with the same name as a bundled one takes priority.',
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
      paintConnectTimeoutSeconds: {
        type: 'number',
        title: 'Paint connect timeout (seconds)',
        description: 'How long to wait for a device to accept a BLE connection before giving up on a repaint attempt.',
        minimum: 1,
        default: defaults.paintConnectTimeoutSeconds,
      },
      paintRetries: {
        type: 'number',
        title: 'Paint retries',
        description: 'How many times to attempt a repaint (including the first try) before giving up and reporting failure.',
        minimum: 1,
        default: defaults.paintRetries,
      },
      signalkApiUrl: {
        type: 'string',
        title: 'SignalK API base URL (leave blank to auto-detect)',
        description:
          'Used for plugin access to SignalK REST APIs not yet integrated for direct plugin access. Left blank, the plugin probes the likely options at startup (3000, 80, 443 ) - only set this manually to skip probing. Anonymous read access is required.',
        enum: ['', ...SIGNALK_API_URL_OPTIONS],
      },
      devices: {
        type: 'array',
        title: 'Devices',
        items: {
          type: 'object',
          required: ['friendlyName', 'device', 'templateName', 'repaintTrigger'],
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

            templateName: withEnum({ type: 'string', title: 'Template' }, templateNameOptions(resolveTemplatesDir(current.templatesDir))),
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
