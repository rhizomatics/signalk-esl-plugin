import { Adapter, Bluetooth, Device, createBluetooth as createBluetoothImpl } from 'node-ble';

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
