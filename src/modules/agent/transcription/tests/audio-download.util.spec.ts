// downloadAudio runs the same SSRF guard as downloadImage; the test hosts
// ("cdn") aren't real, so stub DNS to a public address. Private IP LITERALS
// are still rejected without DNS (see the SSRF cases below).
jest.mock('node:dns/promises', () => ({
  lookup: jest
    .fn()
    .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

import {
  AudioFetchError,
  AudioTooLargeError,
  AudioUnsupportedError,
  downloadAudio,
  sniffMp4DurationSec,
} from '../audio-download.util';

/** Minimal MP4 header: size + 'ftyp' box at offset 4 — enough for the sniffer. */
const MP4 = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
]);

/** 'OggS' capture pattern. */
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02]);

/** MP3 frame sync 0xFF 0xFB. */
const MP3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);

/** EBML magic (webm/mkv) — deliberately unsupported. */
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00]);

interface FakeResponseInit {
  ok?: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

function mockFetchOnce(init: FakeResponseInit): void {
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const body = init.body ?? new Uint8Array();
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    arrayBuffer: () =>
      Promise.resolve(
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      ),
  });
}

/**
 * Build a synthetic mvhd box (version 0) inside a buffer: fourcc at `at`,
 * timescale/duration at the spec offsets relative to the fourcc.
 */
function mvhdBuffer(timescale: number, duration: number): Buffer {
  const buf = Buffer.alloc(64);
  buf.write('mvhd', 8, 'ascii'); // fourcc at index 8
  buf.writeUInt8(0, 12); // version 0
  buf.writeUInt32BE(timescale, 8 + 16);
  buf.writeUInt32BE(duration, 8 + 20);
  return buf;
}

describe('downloadAudio', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('returns buffer + media type from a 2xx audio/mp4 response', async () => {
    mockFetchOnce({ headers: { 'content-type': 'audio/mp4' }, body: MP4 });
    const out = await downloadAudio('https://cdn/v.mp4');
    expect(out.mediaType).toBe('audio/mp4');
    expect(out.buffer.length).toBe(MP4.length);
  });

  it('normalizes m4a content-type aliases to audio/mp4', async () => {
    mockFetchOnce({ headers: { 'content-type': 'audio/x-m4a' }, body: MP4 });
    const out = await downloadAudio('https://cdn/v.m4a');
    expect(out.mediaType).toBe('audio/mp4');
  });

  it('sniffs mp4 from magic bytes when the content-type is generic', async () => {
    mockFetchOnce({
      headers: { 'content-type': 'application/octet-stream' },
      body: MP4,
    });
    const out = await downloadAudio('https://cdn/v');
    expect(out.mediaType).toBe('audio/mp4');
  });

  it('sniffs ogg and mp3 from magic bytes', async () => {
    mockFetchOnce({
      headers: { 'content-type': 'application/octet-stream' },
      body: OGG,
    });
    expect((await downloadAudio('https://cdn/a')).mediaType).toBe('audio/ogg');
    mockFetchOnce({
      headers: { 'content-type': 'application/octet-stream' },
      body: MP3,
    });
    expect((await downloadAudio('https://cdn/b')).mediaType).toBe('audio/mpeg');
  });

  it('rejects webm (unsupported by the provider) with AudioUnsupportedError', async () => {
    mockFetchOnce({ headers: { 'content-type': 'audio/webm' }, body: WEBM });
    await expect(downloadAudio('https://cdn/v.webm')).rejects.toBeInstanceOf(
      AudioUnsupportedError,
    );
  });

  it('throws AudioUnsupportedError on an empty body', async () => {
    mockFetchOnce({ headers: { 'content-type': 'audio/mp4' } });
    await expect(downloadAudio('https://cdn/empty')).rejects.toBeInstanceOf(
      AudioUnsupportedError,
    );
  });

  it('throws AudioFetchError on a non-2xx response', async () => {
    mockFetchOnce({ ok: false, status: 404 });
    await expect(downloadAudio('https://cdn/404')).rejects.toBeInstanceOf(
      AudioFetchError,
    );
  });

  it('throws AudioFetchError when fetch itself rejects', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(
      new Error('network down'),
    );
    await expect(downloadAudio('https://cdn/down')).rejects.toBeInstanceOf(
      AudioFetchError,
    );
  });

  it('throws AudioTooLargeError when content-length exceeds the cap', async () => {
    mockFetchOnce({
      headers: { 'content-type': 'audio/mp4', 'content-length': '99999999' },
      body: MP4,
    });
    await expect(
      downloadAudio('https://cdn/big', { maxBytes: 100 }),
    ).rejects.toBeInstanceOf(AudioTooLargeError);
  });

  it('throws AudioTooLargeError when the body exceeds the cap', async () => {
    mockFetchOnce({ headers: { 'content-type': 'audio/mp4' }, body: MP4 });
    await expect(
      downloadAudio('https://cdn/big', { maxBytes: 4 }),
    ).rejects.toBeInstanceOf(AudioTooLargeError);
  });

  // SSRF guard: customer-supplied URLs must never reach internal hosts.
  it('throws AudioFetchError for the cloud-metadata IP (SSRF guard)', async () => {
    await expect(
      downloadAudio('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toBeInstanceOf(AudioFetchError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws AudioFetchError for a loopback URL (SSRF guard)', async () => {
    await expect(
      downloadAudio('http://127.0.0.1:3000/x'),
    ).rejects.toBeInstanceOf(AudioFetchError);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('sniffMp4DurationSec', () => {
  it('reads a version-0 mvhd timescale/duration pair', () => {
    // 1000 ticks/sec × 90_000 ticks = 90 seconds.
    expect(sniffMp4DurationSec(mvhdBuffer(1000, 90_000))).toBe(90);
  });

  it('returns undefined when no mvhd box is present', () => {
    expect(sniffMp4DurationSec(Buffer.from(MP4))).toBeUndefined();
  });

  it('returns undefined on a zero timescale (malformed)', () => {
    expect(sniffMp4DurationSec(mvhdBuffer(0, 90_000))).toBeUndefined();
  });

  it('returns undefined when the box is truncated', () => {
    expect(
      sniffMp4DurationSec(mvhdBuffer(1000, 90_000).subarray(0, 14)),
    ).toBeUndefined();
  });
});
