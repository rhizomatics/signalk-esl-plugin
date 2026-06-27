import { Adapter } from 'node-ble';
import { Bitmap } from '../render/types';

export type Colour = 'black' | 'white' | 'red' | 'yellow';

/**
 * Static facts about one device model, keyed by (vendor, pid) by the registry —
 * PID alone is not assumed unique across vendors.
 */
export interface DeviceMetadata {
  pid: number;
  /**
   * Disambiguates physical hardware that shares a PID (some vendors reuse PIDs across
   * panel sizes) - the exact advertised value to match against; omit for the variant
   * that should be treated as the default/fallback for that PID.
   */
  hwVersion?: string;
  label: string;
  width: number;
  height: number;
  voffset: number;
  colours: Colour[];
}

export interface DiscoveredDevice {
  address: string;
  name?: string;
  vendor: string;
  pid?: number;
  metadata?: DeviceMetadata;
  rssi?: number;
  /** BLE manufacturer ID (the key of the advertisement's manufacturer data), if advertised. */
  manufacturerId?: number;
  /** Battery level in millivolts, if the driver was able to read it during the scan. */
  batteryMv?: number;
}

/** Manual model facts a user can supply for hardware that isn't yet in a driver's PID table. */
export type DeviceModelOverride = Omit<DeviceMetadata, 'pid'>;

/** Per-device settings the user supplies when registering a device, beyond what's in DeviceMetadata. */
export interface VendorDeviceConfig {
  address: string;
  /** AES key for vendors that need it, entered by the user. If omitted, vendors that have one may fall back to a stock/manufacturer-default key instead of failing. */
  aesKey?: string;
  /** Forces the device model facts instead of looking up the advertised PID - for hardware not yet in the driver's table. */
  modelOverride?: DeviceModelOverride;
}

export interface VendorDriver {
  vendor: string;

  /** Does this advertisement look like it came from one of this vendor's devices? */
  matchesAdvertisement(name: string | undefined, manufacturerId: number | undefined): boolean;

  /** hwVersion disambiguates PIDs a vendor reuses across panel sizes - see `DeviceMetadata.hwVersion`. */
  metadataForPid(pid: number, hwVersion?: string): DeviceMetadata | undefined;

  /** All device models this driver currently has confirmed metadata for. */
  supportedDevices(): DeviceMetadata[];

  /**
   * Enumerates and identifies this vendor's devices from an already-discovering (or
   * already-stopped, using BlueZ's cache) `adapter` - the discovery window itself is owned by the
   * shared caller (see `bleDiscovery.ts`'s `withDiscovery`), not this method, so scanning across
   * multiple registered drivers costs one discovery window total, not one per driver.
   */
  scan(adapter: Adapter): Promise<DiscoveredDevice[]>;

  /** Quantise the common bitmap to this device's palette/encoding and send it over BLE. */
  paint(bitmap: Bitmap, config: VendorDeviceConfig): Promise<void>;
}
