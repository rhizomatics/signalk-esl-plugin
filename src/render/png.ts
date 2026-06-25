import { PNG } from 'pngjs';
import { Bitmap } from './types';

/** Encodes a common Bitmap as PNG bytes, for previewing templates without a physical device. */
export function bitmapToPng(bitmap: Bitmap): Buffer {
  const png = new PNG({ width: bitmap.width, height: bitmap.height });
  png.data = Buffer.from(bitmap.data);
  return PNG.sync.write(png);
}
