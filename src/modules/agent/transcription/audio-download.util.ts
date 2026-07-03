/**
 * Fetch a remote customer voice note (a temporary Facebook CDN URL) into
 * bytes + media type, so it can be sent to the transcription model as base64.
 *
 * Mirrors vision/image-download.util.ts: the model provider cannot re-fetch an
 * expiring URL (and Mastra's OpenRouter provider rejects http(s) audio URLs
 * outright — base64 only), so we download once and inline the bytes. Failures
 * are typed so TranscriptionService can degrade gracefully:
 *  - AudioTooLargeError   → the recording exceeds the byte cap ('too_large').
 *  - AudioFetchError      → network/HTTP/timeout/SSRF-blocked ('fetch_failed').
 *  - AudioUnsupportedError → bytes are empty or not a supported audio format
 *    ('unsupported_format'); notably audio/webm, which the bundled OpenRouter
 *    provider cannot map to an input_audio format.
 */

import { assertPublicHttpUrl } from '@/common/net/url-safety';

/** Media types the OpenRouter provider maps to input_audio formats. */
export type SupportedAudioMediaType =
  | 'audio/mp4' // Messenger voice notes (AAC in an MP4 container) → 'm4a'
  | 'audio/mpeg'
  | 'audio/wav'
  | 'audio/ogg'
  | 'audio/aac';

export interface DownloadedAudio {
  buffer: Buffer;
  mediaType: SupportedAudioMediaType;
  /** Best-effort MP4 mvhd duration; undefined when not sniffable. */
  durationSec?: number;
}

export interface DownloadAudioOptions {
  /** Max raw bytes accepted (base64 inflates ~33%; keep well under model cap). */
  maxBytes?: number;
  /** Abort the fetch after this many milliseconds. */
  timeoutMs?: number;
}

/** Network / HTTP / timeout / SSRF failure fetching a remote audio file. */
export class AudioFetchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AudioFetchError';
  }
}

/** The recording exceeds the configured byte cap (cost/latency guard). */
export class AudioTooLargeError extends AudioFetchError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AudioTooLargeError';
  }
}

/** Empty body or a format the transcription provider cannot accept. */
export class AudioUnsupportedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AudioUnsupportedError';
  }
}

const DEFAULT_MAX_BYTES = 10_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Header content-type → supported media type. Messenger serves voice notes as
 * audio/mp4 (sometimes audio/x-m4a); the m4a aliases all normalize to
 * audio/mp4, which the provider maps to the 'm4a' input_audio format.
 */
const HEADER_MEDIA_TYPES: Record<string, SupportedAudioMediaType> = {
  'audio/mp4': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-m4a': 'audio/mp4',
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/ogg': 'audio/ogg',
  'application/ogg': 'audio/ogg',
  'audio/aac': 'audio/aac',
  'audio/x-aac': 'audio/aac',
};

/**
 * Sniff the media type from magic bytes — Facebook CDNs sometimes serve media
 * as application/octet-stream. Returns undefined when unrecognized (which
 * deliberately includes webm/EBML — unsupported upstream).
 */
function sniffAudioMediaType(buf: Buffer): SupportedAudioMediaType | undefined {
  // MP4/M4A: 'ftyp' box at offset 4.
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    return 'audio/mp4';
  }
  // MP3: 'ID3' tag, or an MPEG audio frame sync (0xFF 0xFB/0xF3/0xF2).
  if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') {
    return 'audio/mpeg';
  }
  if (
    buf.length >= 2 &&
    buf[0] === 0xff &&
    (buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2)
  ) {
    return 'audio/mpeg';
  }
  // Ogg: 'OggS'.
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') {
    return 'audio/ogg';
  }
  // WAV: 'RIFF' … 'WAVE'.
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WAVE'
  ) {
    return 'audio/wav';
  }
  // Raw AAC in an ADTS stream (0xFF 0xF1/0xF9 sync).
  if (
    buf.length >= 2 &&
    buf[0] === 0xff &&
    (buf[1] === 0xf1 || buf[1] === 0xf9)
  ) {
    return 'audio/aac';
  }
  return undefined;
}

/**
 * Best-effort duration (seconds) from an MP4 'mvhd' box. Fragmented/streamed
 * MP4s may not carry it up front — returns undefined on anything odd; the
 * byte cap stays the hard guard.
 */
export function sniffMp4DurationSec(buf: Buffer): number | undefined {
  try {
    const idx = buf.indexOf('mvhd');
    if (idx < 0 || idx + 4 >= buf.length) return undefined;
    const version = buf.readUInt8(idx + 4);
    // Box layout after the 'mvhd' fourcc: version(1) flags(3), then
    // v0: creation(4) modification(4) timescale(4) duration(4)
    // v1: creation(8) modification(8) timescale(4) duration(8)
    if (version === 0) {
      if (idx + 24 > buf.length) return undefined;
      const timescale = buf.readUInt32BE(idx + 16);
      const duration = buf.readUInt32BE(idx + 20);
      if (timescale <= 0) return undefined;
      return duration / timescale;
    }
    if (version === 1) {
      if (idx + 36 > buf.length) return undefined;
      const timescale = buf.readUInt32BE(idx + 24);
      const duration = Number(buf.readBigUInt64BE(idx + 28));
      if (timescale <= 0 || !Number.isFinite(duration)) return undefined;
      return duration / timescale;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetch a remote audio file to bytes + media type.
 *
 * @throws {AudioTooLargeError} when the recording exceeds maxBytes.
 * @throws {AudioFetchError} on network error, non-2xx, timeout, or unsafe URL.
 * @throws {AudioUnsupportedError} when the bytes are empty or an unrecognized/
 *         unsupported audio type (incl. webm).
 */
export async function downloadAudio(
  url: string,
  options: DownloadAudioOptions = {},
): Promise<DownloadedAudio> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // SSRF guard: the URL is customer-supplied, so never let it reach internal
  // hosts / cloud metadata. Surfaced as AudioFetchError so TranscriptionService
  // degrades gracefully, like any other fetch failure.
  try {
    await assertPublicHttpUrl(url);
  } catch (err) {
    throw new AudioFetchError(
      `blocked unsafe audio URL: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new AudioFetchError(
      `audio fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  if (!res.ok) {
    throw new AudioFetchError(`audio fetch returned HTTP ${res.status}`);
  }

  // Reject oversize early when the server advertises the length.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AudioTooLargeError(
      `audio too large: ${declared} bytes > ${maxBytes}`,
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) {
    throw new AudioUnsupportedError('audio fetch returned an empty body');
  }
  if (buffer.length > maxBytes) {
    throw new AudioTooLargeError(
      `audio too large: ${buffer.length} bytes > ${maxBytes}`,
    );
  }

  const headerType = (res.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const mediaType =
    HEADER_MEDIA_TYPES[headerType] ?? sniffAudioMediaType(buffer);
  if (!mediaType) {
    throw new AudioUnsupportedError(
      `unsupported or unrecognized audio type (content-type: "${headerType || 'none'}")`,
    );
  }

  const durationSec =
    mediaType === 'audio/mp4' ? sniffMp4DurationSec(buffer) : undefined;

  return {
    buffer,
    mediaType,
    ...(durationSec !== undefined ? { durationSec } : {}),
  };
}
