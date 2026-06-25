/** Recognized raster image media types (identified by leading magic bytes). */
export type SniffedImageType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp';

/**
 * Identify a raster image from its leading magic bytes (JPEG / PNG / GIF / WebP).
 * Returns undefined when the bytes are not a recognized image — used to reject
 * non-image uploads cheaply, without decoding the whole file.
 */
export function sniffImageMediaType(buf: Buffer): SniffedImageType | undefined {
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46
  ) {
    return 'image/gif'; // "GIF"
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}
