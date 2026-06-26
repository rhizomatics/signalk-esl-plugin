import { Bitmap } from '../render/types';

export type Colour = 'black' | 'white' | 'red' | 'yellow';

/**
 * Static facts about one device model, keyed by (vendor, pid) by the registry —
 * PID alone is not assumed unique across vendors.
 */
export interface DeviceMetadata {
  pid: number;
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
}

/** Per-device settings the user supplies when registering a device, beyond what's in DeviceMetadata. */
export interface VendorDeviceConfig {
  address: string;
  /** AES key for vendors that need it, entered by the user. If omitted, vendors that have one may fall back to a stock/manufacturer-default key instead of failing. */
  aesKey?: string;
}

export interface VendorDriver {
  vendor: string;

  /** Does this advertisement look like it came from one of this vendor's devices? */
  matchesAdvertisement(name: string | undefined, manufacturerData: Buffer | undefined): boolean;

  metadataForPid(pid: number): DeviceMetadata | undefined;

  /** All device models this driver currently has confirmed metadata for. */
  supportedDevices(): DeviceMetadata[];

  scan(durationMs: number): Promise<DiscoveredDevice[]>;

  /** Quantise the common bitmap to this device's palette/encoding and send it over BLE. */
  paint(bitmap: Bitmap, config: VendorDeviceConfig): Promise<void>;
}
