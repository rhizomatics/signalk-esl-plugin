import { Adapter, Device } from 'node-ble';
import { Bitmap } from '../../render/types';
import { DeviceMetadata, DiscoveredDevice, VendorDeviceConfig, VendorDriver } from '../types';
import { createBluetooth, getOrDiscoverDevice, sleep } from '../bleDiscovery';
import { ZHSUNYCO_PID_METADATA } from './metadata';
import { encodeBitmap } from './encode';
import {
  AdvertisedDeviceInfo,
  COMMAND,
  WOLINK_CHARACTERISTIC_UUIDS,
  WOLINK_SERVICE_UUID,
  ZHSUNYCO_MANUFACTURER_ID,
  authResponse,
  commandHeader,
  decodeAdvertisedInfo,
  decodeBatteryMv,
  decodeStatus,
  resolveAesKey,
} from './protocol';

/** node-ble has no MTU API; this matches the reference driver's mtu(247)-9 default. */
const UPLOAD_CHUNK_SIZE = 238;
const CHUNK_WRITE_DELAY_MS = 20;
const AUTH_SETTLE_DELAY_MS = 500;
const STATUS_WAIT_TIMEOUT_MS = 60_000;
const DEVICE_DISCOVERY_TIMEOUT_MS = 30_000;

export class ZhsunycoDriver implements VendorDriver {
  readonly vendor = 'zhsunyco';

  matchesAdvertisement(name: string | undefined, manufacturerId: number | undefined): boolean {
    return manufacturerId === ZHSUNYCO_MANUFACTURER_ID || (name ?? '').startsWith('WL') || (name ?? '').startsWith('WOESL');
  }

  metadataForPid(pid: number, hwVersion?: string): DeviceMetadata | undefined {
    const candidates = ZHSUNYCO_PID_METADATA.filter((model) => model.pid === pid);
    return candidates.find((model) => model.hwVersion === hwVersion) ?? candidates.find((model) => model.hwVersion === undefined);
  }

  supportedDevices(): DeviceMetadata[] {
    return ZHSUNYCO_PID_METADATA;
  }

  async scan(adapter: Adapter): Promise<DiscoveredDevice[]> {
    const found: DiscoveredDevice[] = [];
    for (const address of await adapter.devices()) {
      const device = await adapter.getDevice(address);
      const name = await device.getName().catch(() => undefined);
      const manufacturerData = await device.getManufacturerData().catch(() => undefined);
      const manufacturerId = manufacturerData ? Number(Object.keys(manufacturerData)[0]) : undefined;
      if (!this.matchesAdvertisement(name, manufacturerId)) {
        continue;
      }

      const advertisedInfo = manufacturerData ? decodeAdvertisedInfo(Object.values(manufacturerData)[0]) : undefined;
      const { info, batteryMv } = await readDeviceDetails(device, advertisedInfo);
      found.push({
        address,
        name,
        vendor: this.vendor,
        pid: info?.pid,
        hwVersion: info?.hwVersion,
        metadata: info ? this.metadataForPid(info.pid, info.hwVersion) : undefined,
        manufacturerId,
        batteryMv,
        rssi: await device
          .getRSSI()
          .then((value) => (value === undefined ? undefined : Number(value)))
          .catch(() => undefined),
      });
    }
    return found;
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
        const metadata = config.modelOverride
          ? { pid: info.pid, ...config.modelOverride }
          : this.metadataForPid(info.pid, info.hwVersion);
        if (!metadata) {
          throw new Error(
            `zhsunyco device reports unrecognised PID 0x${info.pid.toString(16).padStart(4, '0')} - ` +
              'pass --width/--height/--voffset/--colours to describe it manually',
          );
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

/**
 * Battery level needs a connection regardless, so reuse it to also fill in the PID/hwVersion
 * when the advertisement didn't carry decodable manufacturer data - BlueZ's cached
 * advertisement for a device matched purely by its name prefix can lack that, which would
 * otherwise leave a real, nearby device's model (and so its entry in the config UI's
 * device picker - see `deviceOptions()` in `config.ts`) silently missing. Reads the same
 * config characteristic `paint()` reads, just to identify the device rather than to size a
 * render.
 */
async function readDeviceDetails(
  device: Device,
  advertisedInfo: AdvertisedDeviceInfo | undefined,
): Promise<{ info: AdvertisedDeviceInfo | undefined; batteryMv: number | undefined }> {
  try {
    await device.connect();
    try {
      const gatt = await device.gatt();
      const service = await gatt.getPrimaryService(WOLINK_SERVICE_UUID);
      const batteryChar = await service.getCharacteristic(WOLINK_CHARACTERISTIC_UUIDS.battery);
      const batteryMv = decodeBatteryMv(await batteryChar.readValue());
      let info = advertisedInfo;
      if (!info) {
        const configChar = await service.getCharacteristic(WOLINK_CHARACTERISTIC_UUIDS.config);
        info = decodeAdvertisedInfo(await configChar.readValue());
      }
      return { info, batteryMv };
    } finally {
      await device.disconnect();
    }
  } catch {
    return { info: advertisedInfo, batteryMv: undefined };
  }
}
