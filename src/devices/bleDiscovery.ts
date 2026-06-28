import { Adapter, Bluetooth, Device, createBluetooth as createBluetoothImpl } from 'node-ble';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drop-in replacement for `node-ble`'s `createBluetooth` that fails fast and clearly when
 * BLE isn't available at all, instead of letting `dbus-next` crash the whole process.
 *
 * `node-ble` connects to BlueZ over D-Bus, which only exists on Linux. On any other
 * platform (e.g. a developer's Mac), the underlying `dbus-next` socket connection fails
 * and emits an `'error'` event with no listener attached - Node treats that as an
 * uncaught exception rather than a promise rejection, so no `try`/`catch` around
 * `createBluetooth()` or its callers can see it; it takes the whole process down.
 */
export function createBluetooth(): { bluetooth: Bluetooth; destroy: () => void } {
  if (process.platform !== 'linux') {
    throw new Error(
      `BLE support requires Linux (BlueZ over D-Bus); "${process.platform}" is not supported - ` +
        'run this on the target Linux host (e.g. the NanoPi), not on macOS/Windows.',
    );
  }
  return createBluetoothImpl();
}

/** BLE manufacturer ID advertised by the device, if any - the key of its manufacturer data map. */
export async function getManufacturerId(device: Device): Promise<number | undefined> {
  const manufacturerData = await device.getManufacturerData().catch(() => undefined);
  const [key] = Object.keys(manufacturerData ?? {});
  return key === undefined ? undefined : Number(key);
}

export interface AdvertisedDevice {
  address: string;
  device: Device;
  name?: string;
  manufacturerId?: number;
  manufacturerData?: Buffer;
}

/**
 * Reads each nearby device's advertisement exactly once and hands it to `fn` - shared by
 * `plugin.ts`'s startup scan and the CLI's `scan` command so that identifying which vendor (if
 * any) a device belongs to costs one `getName`/`getManufacturerData` read per device total, not
 * one per device per registered driver.
 */
export async function forEachAdvertisedDevice(adapter: Adapter, fn: (advertised: AdvertisedDevice) => Promise<void>): Promise<void> {
  for (const address of await adapter.devices()) {
    // BlueZ can drop a device from its cache between `adapter.devices()` listing it and this
    // lookup (e.g. it went out of range mid-scan) - skip it rather than aborting the whole scan.
    const device = await adapter.getDevice(address).catch(() => undefined);
    if (!device) {
      continue;
    }
    const name = await device.getName().catch(() => undefined);
    const manufacturerData = await device.getManufacturerData().catch(() => undefined);
    const [key] = Object.keys(manufacturerData ?? {});
    const manufacturerId = key === undefined ? undefined : Number(key);
    await fn({ address, device, name, manufacturerId, manufacturerData: key === undefined ? undefined : manufacturerData![key] });
  }
}

/**
 * Opens exactly one BLE discovery window and one D-Bus/BlueZ session, then hands the adapter to
 * `fn` - shared by `plugin.ts`'s startup scan and the CLI's `scan` command so scanning across
 * multiple registered vendor drivers costs one discovery window total, not one window per driver.
 */
export async function withDiscovery<T>(durationMs: number, fn: (adapter: Adapter) => Promise<T>): Promise<T> {
  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    const wasDiscovering = await adapter.isDiscovering();
    if (!wasDiscovering) {
      await adapter.startDiscovery();
    }
    await sleep(durationMs);
    if (!wasDiscovering) {
      await adapter.stopDiscovery();
    }
    return await fn(adapter);
  } finally {
    destroy();
  }
}

/**
 * `device.connect()` has no timeout of its own - BlueZ's underlying D-Bus `Connect` call can hang
 * indefinitely for a device that's out of range or stuck mid-handshake, which would otherwise
 * block a scan (or `paint()`) on that one device forever. Throws once `timeoutMs` elapses; if the
 * connect does eventually resolve afterwards, disconnects in the background so a stray successful
 * connection doesn't itself block the next attempt.
 */
export async function connectWithTimeout(device: Device, timeoutMs: number): Promise<void> {
  const connecting = device.connect();
  let timedOut = false;
  await Promise.race([connecting, sleep(timeoutMs).then(() => void (timedOut = true))]);
  if (timedOut) {
    connecting.then(() => device.disconnect()).catch(() => {});
    throw new Error(`connecting to device timed out after ${timeoutMs}ms`);
  }
}

/** Uses an already-known device if BlueZ has one cached, otherwise scans until it appears. */
export async function getOrDiscoverDevice(adapter: Adapter, address: string, timeoutMs: number): Promise<Device> {
  try {
    return await adapter.getDevice(address);
  } catch {
    const wasDiscovering = await adapter.isDiscovering();
    if (!wasDiscovering) {
      await adapter.startDiscovery();
    }
    try {
      return await adapter.waitDevice(address, timeoutMs);
    } finally {
      if (!wasDiscovering) {
        await adapter.stopDiscovery();
      }
    }
  }
}
