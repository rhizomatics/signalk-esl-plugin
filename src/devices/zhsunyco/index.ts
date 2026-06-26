import { createBluetooth, Device } from 'node-ble';
import { Bitmap } from '../../render/types';
import { DeviceMetadata, DiscoveredDevice, VendorDeviceConfig, VendorDriver } from '../types';
import { getOrDiscoverDevice } from '../bleDiscovery';
import { ZHSUNYCO_PID_METADATA } from './metadata';
import { encodeBitmap } from './encode';
import {
  AdvertisedDeviceInfo,
  COMMAND,
  WOLINK_CHARACTERISTIC_UUIDS,
  WOLINK_SERVICE_UUID,
  authResponse,
  commandHeader,
  decodeAdvertisedInfo,
  decodeStatus,
  resolveAesKey,
} from './protocol';

/** node-ble has no MTU API; this matches the reference driver's mtu(247)-9 default. */
const UPLOAD_CHUNK_SIZE = 238;
const CHUNK_WRITE_DELAY_MS = 20;
const AUTH_SETTLE_DELAY_MS = 500;
const STATUS_WAIT_TIMEOUT_MS = 60_000;
const DEVICE_DISCOVERY_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ZhsunycoDriver implements VendorDriver {
  readonly vendor = 'zhsunyco';

  matchesAdvertisement(name: string | undefined): boolean {
    return (name ?? '').startsWith('WL') || (name ?? '').startsWith('WOESL');
  }

  metadataForPid(pid: number): DeviceMetadata | undefined {
    return ZHSUNYCO_PID_METADATA[pid];
  }

  supportedDevices(): DeviceMetadata[] {
    return Object.values(ZHSUNYCO_PID_METADATA);
  }

  async scan(durationMs: number): Promise<DiscoveredDevice[]> {
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

      const found: DiscoveredDevice[] = [];
      for (const address of await adapter.devices()) {
        const device = await adapter.getDevice(address);
        const name = await device.getName().catch(() => undefined);
        if (!this.matchesAdvertisement(name)) {
          continue;
        }

        const info = await readAdvertisedInfo(device);
        found.push({
          address,
          name,
          vendor: this.vendor,
          pid: info?.pid,
          metadata: info ? this.metadataForPid(info.pid) : undefined,
          rssi: await device
            .getRSSI()
            .then((value) => (value === undefined ? undefined : Number(value)))
            .catch(() => undefined),
        });
      }
      return found;
    } finally {
      destroy();
    }
  }

  async paint(bitmap: Bitmap, config: VendorDeviceConfig): Promise<void> {
    const aesKey = resolveAesKey(config.aesKey);

    const { bluetooth, destroy } = createBluetooth();
    try {
      const adapter = await bluetooth.defaultAdapter();
      const device = await getOrDiscoverDevice(adapter, config.address, DEVICE_DISCOVERY_TIMEOUT_MS);

      await device.connect();
      try {
        const gatt = await device.gatt();
        const service = await gatt.getPrimaryService(WOLINK_SERVICE_UUID);
        const dataChar = await service.getCharacteristic(WOLINK_CHARACTERISTIC_UUIDS.data);
        const configChar = await service.getCharacteristic(WOLINK_CHARACTERISTIC_UUIDS.config);
        const authChar = await service.getCharacteristic(WOLINK_CHARACTERISTIC_UUIDS.authenticate);
        const statusChar = await service.getCharacteristic(WOLINK_CHARACTERISTIC_UUIDS.status);

        const info = decodeAdvertisedInfo(await configChar.readValue());
        if (!info) {
          throw new Error('zhsunyco device did not return valid config data');
        }
        const metadata = this.metadataForPid(info.pid);
        if (!metadata) {
          throw new Error(`zhsunyco device reports unrecognised PID 0x${info.pid.toString(16).padStart(4, '0')}`);
        }

        const statusReceived = new Promise<void>((resolve, reject) => {
          statusChar.once('valuechanged', (data: Buffer) => {
            const { errorCode } = decodeStatus(data);
            if (errorCode === 0) {
              resolve();
            } else {
              reject(new Error(`zhsunyco device reported error 0x${errorCode.toString(16).padStart(2, '0')} after refresh`));
            }
          });
        });
        await statusChar.startNotifications();

        const challenge = await authChar.readValue();
        await authChar.writeValueWithoutResponse(authResponse(challenge, aesKey));
        await sleep(AUTH_SETTLE_DELAY_MS);

        const pixelData = encodeBitmap(bitmap, metadata);
        for (let offset = 0; offset < pixelData.length; offset += UPLOAD_CHUNK_SIZE) {
          const chunk = pixelData.subarray(offset, offset + UPLOAD_CHUNK_SIZE);
          await dataChar.writeValueWithResponse(Buffer.concat([commandHeader(COMMAND.uploadBlock, offset), chunk]));
          await sleep(CHUNK_WRITE_DELAY_MS);
        }
        await dataChar.writeValueWithResponse(commandHeader(COMMAND.refreshUncompressed, pixelData.length));

        await Promise.race([statusReceived, sleep(STATUS_WAIT_TIMEOUT_MS)]);
      } finally {
        await device.disconnect();
      }
    } finally {
      destroy();
    }
  }
}

async function readAdvertisedInfo(device: Device): Promise<AdvertisedDeviceInfo | undefined> {
  try {
    const manufacturerData = await device.getManufacturerData();
    const [bytes] = Object.values(manufacturerData);
    return bytes ? decodeAdvertisedInfo(bytes) : undefined;
  } catch {
    return undefined;
  }
}
