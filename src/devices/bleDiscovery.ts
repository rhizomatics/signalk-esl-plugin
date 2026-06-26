import { Adapter, Device } from 'node-ble';

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
