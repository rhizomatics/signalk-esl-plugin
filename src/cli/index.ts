#!/usr/bin/env node
import { readFile, writeFile } from 'fs/promises';
import { Command } from 'commander';
import { DOMParser } from '@xmldom/xmldom';
import { allDrivers, getDriver, registerDriver } from '../devices/registry';
import { ZhsunycoDriver } from '../devices/zhsunyco';
import { createBluetooth, getManufacturerId, getOrDiscoverDevice, withDiscovery } from '../devices/bleDiscovery';
import { Colour, DeviceModelOverride } from '../devices/types';
import { SvgRenderer } from '../render/svgRenderer';
import { bitmapToPng } from '../render/png';
import { Binding, findBindings, parseBinding, renderBinding } from '../render/binding';
import { assembleLiveContext } from './liveContext';
import { logDebug, setLogLevel } from './log';

registerDriver(new ZhsunycoDriver());

const VENDOR_IDENTIFY_TIMEOUT_MS = 30_000;
const DEFAULT_SIGNALK_URL = 'http://localhost:3000';

const COLOUR_CODES: Record<string, Colour[]> = {
  BW: ['black', 'white'],
  BWR: ['black', 'white', 'red'],
  BWRY: ['black', 'white', 'red', 'yellow'],
};

function parseColours(code: string): Colour[] {
  const colours = COLOUR_CODES[code.toUpperCase()];
  if (!colours) {
    throw new Error(`unknown --colours value "${code}" - expected one of ${Object.keys(COLOUR_CODES).join(', ')}`);
  }
  return colours;
}

/** Connects long enough to read the advertised name and manufacturer ID, then matches against registered drivers. */
async function identifyVendor(address: string): Promise<string> {
  const { bluetooth, destroy } = createBluetooth();
  try {
    logDebug(`connecting to ${address} to identify its vendor (timeout ${VENDOR_IDENTIFY_TIMEOUT_MS}ms)`);
    const adapter = await bluetooth.defaultAdapter();
    const device = await getOrDiscoverDevice(adapter, address, VENDOR_IDENTIFY_TIMEOUT_MS);
    const name = await device.getName().catch(() => undefined);
    const manufacturerId = await getManufacturerId(device);
    logDebug(`${address}: advertised name="${name ?? ''}" manufacturerId=${manufacturerId ?? 'unknown'}`);
    const driver = allDrivers().find((candidate) => candidate.matchesAdvertisement(name, manufacturerId));
    if (!driver) {
      throw new Error(`no registered vendor driver recognises device "${name ?? address}" - specify --vendor explicitly`);
    }
    return driver.vendor;
  } finally {
    destroy();
  }
}

const program = new Command();
program.name('esl-cli').description('Local CLI for testing ESL device scan and paint without a SignalK server');

program.option(
  '-r, --require <module>',
  'require a module before running, e.g. an npm package that registers a vendor driver (repeatable)',
  (value, previous: string[] = []) => [...previous, value],
);
program.option('-l, --log-level <level>', 'log verbosity: info or debug (e.g. trace which URLs are fetched)', 'info');

program.hook('preAction', () => {
  setLogLevel(program.opts().logLevel);
  for (const mod of (program.opts().require as string[] | undefined) ?? []) {
    require(mod);
  }
});

program
  .command('vendors')
  .description('List supported vendors and the device models each has confirmed metadata for')
  .action(() => {
    const header = ['vendor', 'pid', 'hwid', 'label', 'size', 'colours'];
    const rows: string[][] = [];
    for (const driver of allDrivers()) {
      for (const device of driver.supportedDevices()) {
        rows.push([
          driver.vendor,
          `0x${device.pid.toString(16).padStart(4, '0')}`,
          device.hwVersion ? `0x${device.hwVersion}` : '',
          device.label,
          `${device.width}x${device.height}`,
          device.colours.join(','),
        ]);
      }
    }
    if (rows.length === 0) {
      console.log('(no confirmed devices yet)');
      return;
    }
    const widths = header.map((title, col) => Math.max(title.length, ...rows.map((row) => row[col].length)));
    const printRow = (row: string[]) => console.log(row.map((cell, col) => cell.padEnd(widths[col])).join('  '));
    printRow(header);
    rows.forEach(printRow);
  });

program
  .command('scan')
  .description('Scan for supported BLE ESL devices across all registered vendor drivers')
  .option('-d, --duration <seconds>', 'scan duration in seconds', '10')
  .option(
    '-a, --all-devices',
    'list every nearby BLE device, not just ones a registered driver recognised - unmatched devices show address/name/mfr/rssi only, since there\'s no driver to do a vendor-specific read like battery',
  )
  .action(async (opts) => {
    const durationMs = Number(opts.duration) * 1000;
    const header = ['vendor', 'address', 'name', 'pid', 'label', 'mfr', 'battery', 'rssi'];
    const rows: string[][] = [];
    const matchedAddresses = new Set<string>();
    logDebug(`scanning for ${durationMs}ms`);
    await withDiscovery(durationMs, async (adapter) => {
      for (const driver of allDrivers()) {
        const found = await driver.scan(adapter);
        logDebug(`${driver.vendor}: found ${found.length} device(s)`);
        for (const device of found) {
          matchedAddresses.add(device.address);
          const pid = device.pid !== undefined ? `0x${device.pid.toString(16).padStart(4, '0')}` : '';
          const label = device.metadata?.label ?? '';
          const manufacturerId = device.manufacturerId !== undefined ? `0x${device.manufacturerId.toString(16).padStart(4, '0')}` : '';
          const battery = device.batteryMv !== undefined ? `${device.batteryMv}mV` : '';
          rows.push([driver.vendor, device.address, device.name ?? '', pid, label, manufacturerId, battery, String(device.rssi ?? '')]);
        }
      }
      if (opts.allDevices) {
        for (const address of await adapter.devices()) {
          if (matchedAddresses.has(address)) {
            continue;
          }
          const device = await adapter.getDevice(address);
          const name = await device.getName().catch(() => undefined);
          const manufacturerId = await getManufacturerId(device);
          const mfr = manufacturerId !== undefined ? `0x${manufacturerId.toString(16).padStart(4, '0')}` : '';
          const rssi = await device
            .getRSSI()
            .then((value) => (value === undefined ? undefined : Number(value)))
            .catch(() => undefined);
          rows.push(['(unmatched)', address, name ?? '', '', '', mfr, '', String(rssi ?? '')]);
        }
      }
    });
    if (matchedAddresses.size === 0) {
      console.log(`no devices found in ${opts.duration}s - try a longer scan with -d, e.g. "-d 30"`);
    }
    if (rows.length === 0) {
      return;
    }
    const widths = header.map((title, col) => Math.max(title.length, ...rows.map((row) => row[col].length)));
    const printRow = (row: string[]) => console.log(row.map((cell, col) => cell.padEnd(widths[col])).join('  '));
    printRow(header);
    rows.forEach(printRow);
  });

program
  .command('paint')
  .description('Render a template against a live SignalK server and send it to a device')
  .option('-v, --vendor <vendor>', 'vendor driver to use - if omitted, inferred from the device\'s advertised name')
  .requiredOption('-a, --address <address>', 'BLE address of the device')
  .requiredOption('-t, --template <path>', 'path to SVG template')
  .option('-u, --url <url>', 'SignalK server base URL - resolves the template\'s source=signalk/resources bindings', DEFAULT_SIGNALK_URL)
  .option('-k, --aes-key <hex>', 'AES-128 key for device authentication, as 32 hex characters - defaults to the vendor\'s stock key if omitted')
  .option('-w, --width <px>', 'render width', '416')
  .option('--height <px>', 'render height', '240')
  .option('--voffset <px>', 'vertical pixel offset of the panel - overrides the looked-up model for unsupported hardware (requires --colours)', '0')
  .option('--colours <code>', 'device colour palette for unsupported hardware: BW, BWR, or BWRY - overrides the looked-up model (uses --width/--height/--voffset)')
  .action(async (opts) => {
    const vendor = opts.vendor ?? (await identifyVendor(opts.address));
    const driver = getDriver(vendor);
    if (!driver) {
      throw new Error(`no driver registered for vendor "${vendor}"`);
    }
    const modelOverride: DeviceModelOverride | undefined = opts.colours
      ? {
          label: 'manual override',
          width: Number(opts.width),
          height: Number(opts.height),
          voffset: Number(opts.voffset),
          colours: parseColours(opts.colours),
        }
      : undefined;
    const bindings = findBindings(await readFile(opts.template, 'utf-8'));
    const context = await assembleLiveContext(opts.url, bindings);
    const renderer = new SvgRenderer();
    const bitmap = await renderer.render(opts.template, context, Number(opts.width), Number(opts.height));
    await driver.paint(bitmap, { address: opts.address, aesKey: opts.aesKey, modelOverride });
    console.log(`painted ${opts.address} (${bitmap.width}x${bitmap.height})`);
  });

program
  .command('render')
  .description('Render a template against a live SignalK server and write a PNG, without needing a device')
  .requiredOption('-t, --template <path>', 'path to SVG template')
  .requiredOption('-o, --output <path>', 'output PNG path')
  .option('-u, --url <url>', 'SignalK server base URL - resolves the template\'s source=signalk/resources bindings', DEFAULT_SIGNALK_URL)
  .option('-w, --width <px>', 'render width', '416')
  .option('--height <px>', 'render height', '240')
  .option(
    '-f, --font <path>',
    'override a bundled font with this file (repeatable) - defaults to the bundled monospace/sans-serif/serif trio',
    (value, previous: string[] = []) => [...previous, value],
  )
  .action(async (opts) => {
    const bindings = findBindings(await readFile(opts.template, 'utf-8'));
    const context = await assembleLiveContext(opts.url, bindings);
    const renderer = opts.font ? new SvgRenderer(opts.font) : new SvgRenderer();
    const bitmap = await renderer.render(opts.template, context, Number(opts.width), Number(opts.height));
    await writeFile(opts.output, bitmapToPng(bitmap));
    console.log(`wrote ${opts.output} (${bitmap.width}x${bitmap.height})`);
  });

program
  .command('fields')
  .description('List every <desc> binding in a template by element id, with its source spec and resolved value')
  .requiredOption('-t, --template <path>', 'path to SVG template')
  .option('-u, --url <url>', 'SignalK server base URL - resolves the template\'s source=signalk/resources bindings', DEFAULT_SIGNALK_URL)
  .action(async (opts) => {
    const doc = new DOMParser().parseFromString(await readFile(opts.template, 'utf-8'), 'image/svg+xml');
    const elements = doc.getElementsByTagName('text');
    const rows: { id: string; desc: string; binding?: Binding; error?: string }[] = [];
    for (let i = 0; i < elements.length; i++) {
      const element = elements.item(i);
      const desc = element?.getElementsByTagName('desc').item(0);
      if (!element || !desc?.textContent) continue;
      const id = element.getAttribute('id') ?? `#${i}`;
      try {
        rows.push({ id, desc: desc.textContent, binding: parseBinding(desc.textContent) });
      } catch (err) {
        rows.push({ id, desc: desc.textContent, error: (err as Error).message });
      }
    }
    const header = ['id', 'spec', 'value'];
    const table = await Promise.all(
      rows.map(async (row) => {
        if (row.error || !row.binding) return [row.id, row.desc, row.error ?? ''];
        try {
          const context = await assembleLiveContext(opts.url, [row.binding]);
          return [row.id, row.desc, renderBinding(row.binding, context)];
        } catch (err) {
          return [row.id, row.desc, `ERROR: ${(err as Error).message}`];
        }
      }),
    );
    const widths = header.map((title, col) => Math.max(title.length, ...table.map((cells) => cells[col].length)));
    const printRow = (cells: string[]) => console.log(cells.map((cell, col) => cell.padEnd(widths[col])).join('  '));
    printRow(header);
    table.forEach(printRow);
  });

program
  .command('field')
  .description('Resolve a single binding spec directly against a live SignalK server, with no template')
  .argument('<spec>', 'binding spec, e.g. "source=resources,resource=tides,path=station.name" or a bare SignalK path')
  .option('-u, --url <url>', 'SignalK server base URL - resolves the spec\'s source=signalk/resources binding', DEFAULT_SIGNALK_URL)
  .action(async (spec, opts) => {
    const binding = parseBinding(spec);
    const context = await assembleLiveContext(opts.url, [binding]);
    console.log(renderBinding(binding, context));
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
