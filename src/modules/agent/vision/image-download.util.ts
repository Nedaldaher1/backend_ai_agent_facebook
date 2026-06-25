/**
 * Fetch a remote customer image (typically a temporary Facebook CDN URL) into
 * bytes + media type, so it can be sent to the vision model as base64.
 *
 * The model provider cannot re-fetch an expiring URL, so we download once and
 * inline the bytes. Failures are typed so the caller (VisionService) can degrade
 * gracefully: ImageFetchError = network/HTTP/timeout/oversize; ImageDecodeError
 * (reused from the embeddings module) = the bytes are not a usable image.
 */

import { ImageDecodeError } from '@/modules/embeddings/image-decode.error';
import { assertPublicHttpUrl } from '@/common/net/url-safety';

/** Media types Claude vision accepts. */
export type SupportedMediaType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp';

export interface DownloadedImage {
  buffer: Buffer;
  mediaType: SupportedMediaType;
}

export interface DownloadImageOptions {
  /** Max raw bytes accepted (base64 inflates ~33%; keep well under model cap). */
  maxBytes?: number;
  /** Abort the fetch after this many milliseconds. */
  timeoutMs?: number;
}

/** Network / HTTP / size failure fetching a remote image (not a decode fault). */
export class ImageFetchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ImageFetchError';
  }
}

const DEFAULT_MAX_BYTES = 5_000_000;
const DEFAULT_TIMEOUT_MS = 8_000;

const HEADER_MEDIA_TYPES: Record<string, SupportedMediaType> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

/**
 * Sniff the media type from magic bytes — Facebook CDNs sometimes serve
 * images as application/octet-stream. Returns undefined when unrecognized.
 */
function sniffMediaType(buf: Buffer): SupportedMediaType | undefined {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
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
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
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

/**
 * Fetch a remote image to bytes + media type.
 *
 * @throws {ImageFetchError} on network error, non-2xx, timeout, or oversize.
 * @throws {ImageDecodeError} when the bytes are empty or an unrecognized type.
 */
export async function downloadImage(
  url: string,
  options: DownloadImageOptions = {},
): Promise<DownloadedImage> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // SSRF guard: the URL is customer-supplied, so never let it reach internal
  // hosts / cloud metadata. Surfaced as ImageFetchError so VisionService
  // degrades gracefully (returns no attributes), like any other fetch failure.
  try {
    await assertPublicHttpUrl(url);
  } catch (err) {
    throw new ImageFetchError(
      `blocked unsafe image URL: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new ImageFetchError(
      `image fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!res.ok) {
    throw new ImageFetchError(`image fetch returned HTTP ${res.status}`);
  }

  // Reject oversize early when the server advertises the length.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ImageFetchError(`image too large: ${declared} bytes > ${maxBytes}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) {
    throw new ImageDecodeError('image fetch returned an empty body');
  }
  if (buffer.length > maxBytes) {
    throw new ImageFetchError(
      `image too large: ${buffer.length} bytes > ${maxBytes}`,
    );
  }

  const headerType = (res.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const mediaType = HEADER_MEDIA_TYPES[headerType] ?? sniffMediaType(buffer);
  if (!mediaType) {
    throw new ImageDecodeError(
      `unsupported or unrecognized image type (content-type: "${headerType || 'none'}")`,
    );
  }

  return { buffer, mediaType };
}
