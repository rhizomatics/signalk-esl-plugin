import Handlebars from 'handlebars';
import { DateTime } from 'luxon';
import { evaluate } from 'mathjs';

/**
 * Matches the shape of a category entry from SignalK's `/signalk/v1/unitpreferences/active`
 * (or `/presets/<name>`) endpoint - see https://demo.signalk.org/documentation/Guides/Unit_Preferences.html.
 * `formula`/`symbol` are only present inline when the target unit isn't the base unit; when
 * absent here, the caller assembling the template context is expected to have already resolved
 * them from `/signalk/v1/unitpreferences/definitions` (or left them out because no conversion
 * is needed, i.e. targetUnit === baseUnit).
 */
interface UnitPreference {
  targetUnit?: string;
  symbol?: string;
  formula?: string;
  displayFormat?: string;
}

/**
 * Shows the explicit IANA zone name rather than an abbreviation (e.g. "BST") —
 * UK tide tables are officially published in GMT, so the basis for the displayed
 * time must be unambiguous rather than just locally styled.
 */
Handlebars.registerHelper('formatTime', (iso: unknown, zone: unknown) => {
  if (typeof iso !== 'string') return '';
  const zoneName = typeof zone === 'string' && zone ? zone : 'utc';
  const dt = DateTime.fromISO(iso, { zone: 'utc' }).setZone(zoneName);
  if (!dt.isValid) return '';
  return `${dt.toFormat('HH:mm')}`;
});

Handlebars.registerHelper('truncate', (value: unknown, decimals: unknown) => {
  if (typeof value !== 'number') return value;
  const places = typeof decimals === 'number' ? decimals : 1;
  return value.toFixed(places);
});

/**
 * IANA region names are ambiguous about DST (e.g. "Europe/London" is UTC+00:00
 * in winter, UTC+01:00 in summer); show the numeric offset actually in effect.
 */
Handlebars.registerHelper('utcOffset', (zone: unknown) => {
  if (typeof zone !== 'string' || !zone) return '';
  const dt = DateTime.now().setZone(zone);
  if (!dt.isValid) return '';
  return `UTC${dt.toFormat('ZZ')}`;
});

/**
 * Converts a base-SI value (always what SignalK paths/APIs deliver) to the user's preferred
 * display unit and formats it with the unit's symbol, e.g. 3.42 -> "11.2ft".
 */
Handlebars.registerHelper('unitValue', (value: unknown, preference: unknown) => {
  if (typeof value !== 'number') return '';
  const pref = (preference ?? {}) as UnitPreference;

  const converted = pref.formula ? Number(evaluate(pref.formula, { value })) : value;
  const decimals = pref.displayFormat?.includes('.') ? pref.displayFormat.split('.')[1].length : 0;
  const symbol = pref.symbol ?? pref.targetUnit ?? '';

  return `${converted.toFixed(decimals)}${symbol}`;
});

Handlebars.registerHelper('tideLabel', (extreme: unknown) => {
  const entry = extreme as { high?: boolean; low?: boolean } | undefined;
  if (entry?.high) return 'High Water';
  if (entry?.low) return 'Low Water';
  return 'Other';
});

export { Handlebars };
