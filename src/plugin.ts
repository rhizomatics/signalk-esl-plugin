import { Plugin, ServerAPI } from '@signalk/server-api';
import { configSchema, configUiSchema, defaultConfig, PluginConfig } from './config';
import { registerDriver, allDrivers } from './devices/registry';
import { ZhsunycoDriver } from './devices/zhsunyco';
import { DiscoveredDevice } from './devices/types';
import { startRepaintScheduler, RepaintScheduler } from './repaintScheduler';

const TIDES_CONTEXT_ID = 'tides';
/** signalk-tides publishes this once it has a forecast - its presence means the plugin is loaded and running. */
const TIDES_PROBE_PATH = 'environment.tide.stationName';
/** Long enough for signalk-tides' own startup delay (it waits ~4s for a GNSS fix before its first update) to have passed. */
const TIDES_DETECT_DELAY_MS = 5_000;

/** Mirrors signalk-bluetti-plugin's convention: scan briefly, report finds via plugin status for the user to copy-paste. */
async function runStartupScan(app: ServerAPI, discovered: DiscoveredDevice[], durationSeconds: number): Promise<void> {
  app.setPluginStatus(`Scanning for ESL devices for ${durationSeconds}s...`);
  const startedAt = Date.now();
  for (const driver of allDrivers()) {
    const devices = await driver.scan(durationSeconds * 1000).catch((err) => {
      app.debug(`${driver.vendor} scan failed: ${err.message}`);
      return [];
    });
    for (const device of devices) {
      discovered.push(device);
      const pid = device.pid !== undefined ? `0x${device.pid.toString(16).padStart(4, '0')}` : 'unknown';
      app.debug(`discovered ${driver.vendor} device "${device.name ?? ''}" [${device.address}] pid=${pid}`);
    }
  }
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (discovered.length === 0) {
    app.setPluginStatus(`Scan complete - no ESL devices found nearby after ${elapsedSeconds} seconds.`);
    return;
  }
  const summary = discovered.map((device) => `${device.name ?? device.vendor} [${device.address}]`).join(', ');
  app.setPluginStatus(`Scan complete - found ${discovered.length} device(s) in ${elapsedSeconds}s: ${summary} - pick one from a device's "Device" field below`);
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
    const current = { ...defaultConfig(app), ...(app.readPluginOptions() as Partial<PluginConfig>) };
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

export function createPlugin(app: ServerAPI): Plugin {
  registerDriver(new ZhsunycoDriver());

  let scheduler: RepaintScheduler | undefined;
  const lastDiscovered: DiscoveredDevice[] = [];
  // node-ble/BlueZ has no scan-cancellation API, so a scan started by a previous start()
  // keeps running its full duration even after stop() - tracking it here stops a quick
  // disable/re-enable from opening a second concurrent D-Bus/BlueZ session, which was
  // making the new scan fail (and report "no devices found") almost immediately.
  let scanInProgress: Promise<unknown> | undefined;

  const plugin: Plugin = {
    id: 'signalk-esl-plugin',
    name: 'eInk ESL (Electronic Shelf Label)',
    description: 'Renders selected SignalK data to BLE eInk Electronic Shelf Labels',
    schema: () => configSchema(app, lastDiscovered),
    uiSchema: () => configUiSchema(),
    start(config: object) {
      const pluginConfig: PluginConfig = { ...defaultConfig(app), ...(config as Partial<PluginConfig>) };
      app.debug(`starting with ${pluginConfig.devices.length} configured device(s)`);

      if (pluginConfig.scanOnStart) {
        if (scanInProgress) {
          app.debug('a scan from before this restart is still running - skipping a new one to avoid a second concurrent BLE session');
        } else {
          lastDiscovered.length = 0;
          const scan = runStartupScan(app, lastDiscovered, pluginConfig.scanDurationSeconds).catch((err) =>
            app.debug(`startup scan failed: ${err.message}`),
          );
          scanInProgress = scan;
          scan.finally(() => {
            scanInProgress = undefined;
          });
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
