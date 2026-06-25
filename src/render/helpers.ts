import Handlebars from 'handlebars';
import { DateTime } from 'luxon';

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
  return `${dt.toFormat('HH:mm')} ${zoneName}`;
});

Handlebars.registerHelper('truncate', (value: unknown, decimals: unknown) => {
  if (typeof value !== 'number') return value;
  const places = typeof decimals === 'number' ? decimals : 1;
  return value.toFixed(places);
});

export { Handlebars };
