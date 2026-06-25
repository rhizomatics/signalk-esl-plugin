#!/usr/bin/env node
import { readFile, writeFile } from 'fs/promises';
import { Command } from 'commander';
import { allDrivers, getDriver, registerDriver } from '../devices/registry';
import { ZhsunycoDriver } from '../devices/zhsunyco';
import { SvgRenderer } from '../render/svgRenderer';
import { bitmapToPng } from '../render/png';

registerDriver(new ZhsunycoDriver());

const program = new Command();
program.name('esl-cli').description('Local CLI for testing ESL device scan and paint without a SignalK server');

program
  .command('vendors')
  .description('List supported vendors and the device models each has confirmed metadata for')
  .action(() => {
    for (const driver of allDrivers()) {
      const devices = driver.supportedDevices();
      if (devices.length === 0) {
        console.log(`${driver.vendor}\t(no confirmed devices yet)`);
        continue;
      }
      for (const device of devices) {
        console.log(`${driver.vendor}\t0x${device.pid.toString(16).padStart(4, '0')}\t${device.label}\t${device.width}x${device.height}\t${device.colours.join(',')}`);
      }
    }
  });

program
  .command('scan')
  .description('Scan for supported BLE ESL devices across all registered vendor drivers')
  .option('-d, --duration <seconds>', 'scan duration in seconds', '10')
  .action(async (opts) => {
    const durationMs = Number(opts.duration) * 1000;
    for (const driver of allDrivers()) {
      const found = await driver.scan(durationMs);
      for (const device of found) {
        console.log(`${driver.vendor}\t${device.address}\t${device.name ?? ''}`);
      }
    }
  });

program
  .command('paint')
  .description('Render a template with dummy data and send it to a device')
  .requiredOption('-v, --vendor <vendor>', 'vendor driver to use')
  .requiredOption('-a, --address <address>', 'BLE address of the device')
  .action(async (opts) => {
    const driver = getDriver(opts.vendor);
    if (!driver) {
      throw new Error(`no driver registered for vendor "${opts.vendor}"`);
    }
    throw new Error('paint not yet implemented: needs the SVG renderer (see SvgRenderer)');
  });

program
  .command('render')
  .description('Render a template against a JSON data fixture and write a PNG, without needing a device')
  .requiredOption('-t, --template <path>', 'path to SVG template')
  .requiredOption('-d, --data <path>', 'path to JSON data fixture')
  .requiredOption('-o, --output <path>', 'output PNG path')
  .option('-w, --width <px>', 'render width', '416')
  .option('--height <px>', 'render height', '240')
  .option(
    '-f, --font <path>',
    'override a bundled font with this file (repeatable) - defaults to the bundled monospace/sans-serif/serif trio',
    (value, previous: string[] = []) => [...previous, value],
  )
  .action(async (opts) => {
    const context = JSON.parse(await readFile(opts.data, 'utf-8'));
    const renderer = opts.font ? new SvgRenderer(opts.font) : new SvgRenderer();
    const bitmap = await renderer.render(opts.template, context, Number(opts.width), Number(opts.height));
    await writeFile(opts.output, bitmapToPng(bitmap));
    console.log(`wrote ${opts.output} (${bitmap.width}x${bitmap.height})`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
