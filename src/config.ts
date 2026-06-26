import { allDrivers } from './devices/registry';

export interface DeviceConfig {
  friendlyName: string;
  vendor: string;
  address: string;
  /** Per-device override; if omitted, the vendor driver may fall back to a stock/manufacturer-default key. */
  aesKey?: string;
  templateName: string;
  dataSourceType: 'signalk-path' | 'api';
  signalkPath?: string;
  apiUrl?: string;
  updateFrequencySeconds: number;
}

export interface PluginConfig {
  /** Directory the plugin scans for template files, instead of an upload UI. */
  templatesDir: string;
  devices: DeviceConfig[];
}

export const DEFAULT_CONFIG: PluginConfig = {
  templatesDir: './templates',
  devices: [],
};

export function configSchema(): object {
  return {
    type: 'object',
    properties: {
      templatesDir: {
        type: 'string',
        title: 'Templates directory',
        description: 'Directory to search for SVG/Handlebars template files',
        default: DEFAULT_CONFIG.templatesDir,
      },
      devices: {
        type: 'array',
        title: 'Devices',
        items: {
          type: 'object',
          required: ['friendlyName', 'vendor', 'address', 'templateName', 'dataSourceType', 'updateFrequencySeconds'],
          properties: {
            friendlyName: { type: 'string', title: 'Friendly name' },
            vendor: { type: 'string', title: 'Vendor', enum: allDrivers().map((driver) => driver.vendor) },
            address: { type: 'string', title: 'BLE address' },
            aesKey: { type: 'string', title: 'BLE AES key (vendor-specific; leave blank to use the vendor\'s stock default key)' },
            templateName: { type: 'string', title: 'Template file name' },
            dataSourceType: { type: 'string', title: 'Data source type', enum: ['signalk-path', 'api'] },
            signalkPath: { type: 'string', title: 'SignalK path (if data source type is signalk-path)' },
            apiUrl: { type: 'string', title: 'API URL (if data source type is api)' },
            updateFrequencySeconds: { type: 'number', title: 'Update frequency (seconds)', default: 300 },
          },
        },
      },
    },
  };
}
