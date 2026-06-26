import { Plugin, ServerAPI } from '@signalk/server-api';
import { configSchema, DEFAULT_CONFIG, PluginConfig } from './config';
import { registerDriver, allDrivers } from './devices/registry';
import { ZhsunycoDriver } from './devices/zhsunyco';
import { DiscoveredDevice } from './devices/types';
import { startRepaintScheduler, RepaintScheduler } from './repaintScheduler';

const STARTUP_SCAN_DURATION_MS = 15_000;
const TIDES_CONTEXT_ID = 'tides';
/** signalk-tides publishes this once it has a forecast - its presence means the plugin is loaded and running. */
const TIDES_PROBE_PATH = 'environment.tide.stationName';
/** Long enough for signalk-tides' own startup delay (it waits ~4s for a GNSS fix before its first update) to have passed. */
const TIDES_DETECT_DELAY_MS = 5_000;

/** Mirrors signalk-bluetti-plugin's convention: scan briefly, report finds via plugin status for the user to copy-paste. */
async function runStartupScan(app: ServerAPI, discovered: DiscoveredDevice[]): Promise<void> {
  app.setPluginStatus(`Scanning for ESL devices for ${STARTUP_SCAN_DURATION_MS / 1000}s...`);
  let found = 0;
  for (const driver of allDrivers()) {
    const devices = await driver.scan(STARTUP_SCAN_DURATION_MS).catch((err) => {
      app.debug(`${driver.vendor} scan failed: ${err.message}`);
      return [];
    });
    for (const device of devices) {
      found++;
      discovered.push(device);
      const pid = device.pid !== undefined ? `0x${device.pid.toString(16).padStart(4, '0')}` : 'unknown';
      app.debug(`discovered ${driver.vendor} device "${device.name ?? ''}" [${device.address}] pid=${pid}`);
      app.setPluginStatus(`Discovered: ${device.name ?? driver.vendor} [${device.address}] - pick it from a device's "Device" field below`);
    }
  }
  if (found === 0) {
    app.setPluginStatus('Scan complete - no ESL devices found nearby.');
  }
}

/**
 * Adds a "tides" context (once) if signalk-tides looks like it's running, so its data is
 * one click away in a device's Context picker instead of the user having to hand-build it.
 * Only the SignalK paths are filled in - the provider URL for its HTTP API is left for the
 * user to add, since this plugin has no way to know the server's own externally-reachable
 * address (e.g. behind a reverse proxy).
 */
function addTidesContextIfDetected(app: ServerAPI): void {
  setTimeout(() => {
    if (app.getSelfPath(TIDES_PROBE_PATH) === undefined) {
      return;
    }
    const current = { ...DEFAULT_CONFIG, ...(app.readPluginOptions() as Partial<PluginConfig>) };
    if (current.contexts.some((context) => context.id === TIDES_CONTEXT_ID)) {
      return;
    }
    const contexts = [...current.contexts, { id: TIDES_CONTEXT_ID, signalkPaths: ['environment.time.timezoneRegion'], providers: [] }];
    app.savePluginOptions({ ...current, contexts }, (err) => {
      if (err) {
        app.debug(`failed to add "${TIDES_CONTEXT_ID}" context: ${err.message}`);
        return;
      }
      app.debug(`signalk-tides detected - added a "${TIDES_CONTEXT_ID}" context (add its API provider URL by hand)`);
    });
  }, TIDES_DETECT_DELAY_MS);
}

/** Clears the one-shot "Rescan now" checkbox once the scan it triggered has completed. */
function clearForceRescan(app: ServerAPI): void {
  const current = { ...DEFAULT_CONFIG, ...(app.readPluginOptions() as Partial<PluginConfig>) };
  app.savePluginOptions({ ...current, forceRescan: false }, (err) => {
    if (err) app.debug(`failed to clear forceRescan: ${err.message}`);
  });
}

export function createPlugin(app: ServerAPI): Plugin {
  registerDriver(new ZhsunycoDriver());

  let scheduler: RepaintScheduler | undefined;
  const lastDiscovered: DiscoveredDevice[] = [];

  const plugin: Plugin = {
    id: 'signalk-esl-plugin',
    name: 'Display SignalK Data on eInk Electronic Shelf Labels',
    description: 'Renders selected SignalK data to BLE eInk Electronic Shelf Labels',
    schema: () => configSchema(app, lastDiscovered),
    start(config: object) {
      const pluginConfig: PluginConfig = { ...DEFAULT_CONFIG, ...(config as Partial<PluginConfig>) };
      app.debug(`starting with ${pluginConfig.devices.length} configured device(s)`);

      if (pluginConfig.scanOnStart || pluginConfig.forceRescan) {
        lastDiscovered.length = 0;
        const scan = runStartupScan(app, lastDiscovered).catch((err) => app.debug(`startup scan failed: ${err.message}`));
        if (pluginConfig.forceRescan) {
          scan.then(() => clearForceRescan(app));
        }
      }

      addTidesContextIfDetected(app);

      scheduler = startRepaintScheduler(app, pluginConfig);
    },
    stop() {
      scheduler?.stop();
      scheduler = undefined;
      app.debug('stopped');
    },
  };

  return plugin;
}
