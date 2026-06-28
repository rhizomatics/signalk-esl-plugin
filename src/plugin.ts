import { Plugin, ServerAPI } from '@signalk/server-api';
import { configSchema, configUiSchema, defaultConfig, PluginConfig } from './config';
import { registerDriver, allDrivers } from './devices/registry';
import { ZhsunycoDriver } from './devices/zhsunyco';
import { forEachAdvertisedDevice, withDiscovery } from './devices/bleDiscovery';
import { DiscoveredDevice } from './devices/types';
import { startRepaintScheduler, RepaintScheduler } from './repaintScheduler';

/** Mirrors signalk-bluetti-plugin's convention: scan briefly, report finds via plugin status for the user to copy-paste. */
async function runStartupScan(app: ServerAPI, discovered: DiscoveredDevice[], durationSeconds: number): Promise<void> {
  app.setPluginStatus(`Scanning for ESL devices for ${durationSeconds}s...`);
  const startedAt = Date.now();
  let scanError: string | undefined;
  const drivers = allDrivers();
  await withDiscovery(durationSeconds * 1000, async (adapter) => {
    await forEachAdvertisedDevice(adapter, async ({ device, address, name, manufacturerId, manufacturerData }) => {
      const driver = drivers.find((candidate) => candidate.matchesAdvertisement(name, manufacturerId));
      if (!driver) {
        return;
      }
      const found = await driver.identifyDevice(device, address, name, manufacturerId, manufacturerData).catch((err) => {
        scanError = `${driver.vendor} scan failed: ${err.message}`;
        app.debug(`${scanError}\n${err.stack ?? ''}`);
        return undefined;
      });
      if (!found) {
        return;
      }
      discovered.push(found);
      const pid = found.pid !== undefined ? `0x${found.pid.toString(16).padStart(4, '0')}` : 'unknown';
      app.debug(`discovered ${driver.vendor} device "${found.name ?? ''}" [${found.address}] pid=${pid}`);
    });
  });
  // Surfaces the real cause in the admin UI (instead of only the debug log) - a scan that
  // ends in well under its configured duration is almost always this, not "no devices nearby".
  app.setPluginError(scanError ?? '');
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (discovered.length === 0) {
    app.setPluginStatus(`Scan complete - no ESL devices found nearby after ${elapsedSeconds} seconds.`);
    return;
  }
  const summary = discovered.map((device) => `${device.name ?? device.vendor} [${device.address}]`).join(', ');
  app.setPluginStatus(`Scan complete - found ${discovered.length} device(s) in ${elapsedSeconds}s: ${summary} - pick one from a device's "Device" field below`);
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
      const pluginConfig: PluginConfig = { ...defaultConfig(), ...(config as Partial<PluginConfig>) };
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
