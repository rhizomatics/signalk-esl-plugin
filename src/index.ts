import { ServerAPI, Plugin } from '@signalk/server-api';
import { createPlugin } from './plugin';
import { registerDriver, getDriver, allDrivers } from './devices/registry';
import type {
  VendorDriver as VendorDriverType,
  DeviceMetadata as DeviceMetadataType,
  DiscoveredDevice as DiscoveredDeviceType,
  VendorDeviceConfig as VendorDeviceConfigType,
  Colour as ColourType,
} from './devices/types';

/**
 * Public extension point for vendor packages. A package that adds support for a new
 * ESL vendor (e.g. `signalk-esl-shoplabelcorp-plugin`) imports this module and calls
 * `plugin.registerDriver(new ShopLabelCorpDriver())` from its own SignalK plugin's
 * `start()` (or at module load time). There's no scanning of installed packages -
 * registration is always an explicit call by the extension's own code.
 *
 * Declare this package as a `peerDependency` (not a regular dependency) in the
 * extension package, so npm resolves a single shared copy - otherwise the extension
 * would register into a different registry instance than the one this plugin reads from.
 */
function plugin(app: ServerAPI): Plugin {
  return createPlugin(app);
}

namespace plugin {
  export const registerVendorDriver = registerDriver;
  export const getVendorDriver = getDriver;
  export const allVendorDrivers = allDrivers;

  export type VendorDriver = VendorDriverType;
  export type DeviceMetadata = DeviceMetadataType;
  export type DiscoveredDevice = DiscoveredDeviceType;
  export type VendorDeviceConfig = VendorDeviceConfigType;
  export type Colour = ColourType;
}

export = plugin;
