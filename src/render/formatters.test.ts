import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { applyFormat, formatDisplayUnits } from './formatters';
import { TemplateContext } from './types';

test('formatDisplayUnits', async (t) => {
  await t.test('applies the conversion formula and symbol', () => {
    const result = formatDisplayUnits(10, { category: 'speed', targetUnit: 'kn', formula: 'value * 1.94384', symbol: 'kn' }, 1);
    assert.equal(result, '19.4kn');
  });

  await t.test('passes the value through unconverted when there is no formula', () => {
    assert.equal(formatDisplayUnits(3.456, { category: 'depth', targetUnit: 'm' }, 1), '3.5m');
  });

  await t.test('falls back to targetUnit when there is no symbol', () => {
    assert.equal(formatDisplayUnits(3, { category: 'depth', targetUnit: 'm' }, 0), '3m');
  });

  await t.test('derives decimal places from displayFormat when round is not given', () => {
    assert.equal(formatDisplayUnits(3.14159, { category: 'depth', targetUnit: 'm', displayFormat: '0.00' }, undefined), '3.14m');
  });
});

test('applyFormat', async (t) => {
  const context: TemplateContext = { signalk: { self: { environment: { time: { timezoneRegion: 'Europe/London' } } } } };

  await t.test('local_time converts a UTC ISO string to the vessel\'s timezone', () => {
    assert.equal(applyFormat('local_time', '2026-06-28T12:00:00Z', context, undefined), '13:00');
  });

  await t.test('local_time falls back to the host machine\'s own timezone when there is no timezoneRegion', () => {
    const expected = DateTime.fromISO('2026-06-28T12:00:00Z', { zone: 'utc' }).setZone(Intl.DateTimeFormat().resolvedOptions().timeZone).toFormat('HH:mm');
    assert.equal(applyFormat('local_time', '2026-06-28T12:00:00Z', {}, undefined), expected);
  });

  await t.test('local_time returns empty string for a non-string value', () => {
    assert.equal(applyFormat('local_time', 42, context, undefined), '');
  });

  await t.test('day_mon formats day and abbreviated month', () => {
    assert.equal(applyFormat('day_mon', '2026-06-28T12:00:00Z', context, undefined), '28 Jun');
  });

  await t.test('local_datetime_short formats day, abbreviated month, 2-digit year and 24h time', () => {
    assert.equal(applyFormat('local_datetime_short', '2026-06-21T17:05:00Z', context, undefined), '21 Jun 26 18:05');
  });

  await t.test('local_datetime_short returns empty string for a non-string value', () => {
    assert.equal(applyFormat('local_datetime_short', 42, context, undefined), '');
  });

  await t.test('utc_offset shows a fixed-offset zone\'s numeric UTC offset', () => {
    assert.equal(applyFormat('utc_offset', 'Etc/UTC', context, undefined), 'UTC+00:00');
  });

  await t.test('position formats latitude/longitude with hemisphere letters', () => {
    const result = applyFormat('position', { latitude: 50.1234, longitude: -4.5678 }, context, 2);
    assert.equal(result, '50.12°N 4.57°W');
  });

  await t.test('position returns empty string when coordinates are missing', () => {
    assert.equal(applyFormat('position', {}, context, undefined), '');
  });

  await t.test('throws for an unknown format name', () => {
    assert.throws(() => applyFormat('nope', 1, context, undefined), /unknown format "nope"/);
  });
});
