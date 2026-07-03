// downloadImage now runs an SSRF guard (audit V1) that resolves the host; the
// test hosts ("cdn", "x") aren't real, so stub DNS to a public address. Private
// IP LITERALS are still rejected without DNS (see the SSRF cases below).
jest.mock('node:dns/promises', () => ({
  lookup: jest
    .fn()
    .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));

import { downloadImage, ImageFetchError } from '../image-download.util';
import { ImageDecodeError } from '@/modules/embeddings/image-decode.error';

/** First 6 bytes of a JPEG (magic 0xFFD8FF…) — enough for the sniffer. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);

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
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  });
}

describe('downloadImage', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('returns buffer + media type from a 2xx image response', async () => {
    mockFetchOnce({ headers: { 'content-type': 'image/jpeg' }, body: JPEG });
    const out = await downloadImage('https://cdn/x.jpg');
    expect(out.mediaType).toBe('image/jpeg');
    expect(out.buffer.length).toBe(JPEG.length);
  });

  it('sniffs the media type when the content-type header is generic', async () => {
    mockFetchOnce({
      headers: { 'content-type': 'application/octet-stream' },
      body: JPEG,
    });
    const out = await downloadImage('https://cdn/x');
    expect(out.mediaType).toBe('image/jpeg');
  });

  it('throws ImageFetchError on a non-2xx response', async () => {
    mockFetchOnce({ ok: false, status: 404 });
    await expect(downloadImage('https://cdn/404')).rejects.toBeInstanceOf(
      ImageFetchError,
    );
  });

  it('throws ImageFetchError when fetch itself rejects', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(
      new Error('network down'),
    );
    await expect(downloadImage('https://cdn/down')).rejects.toBeInstanceOf(
      ImageFetchError,
    );
  });

  it('throws ImageFetchError when content-length exceeds the cap', async () => {
    mockFetchOnce({
      headers: { 'content-type': 'image/jpeg', 'content-length': '99999999' },
      body: JPEG,
    });
    await expect(
      downloadImage('https://cdn/big', { maxBytes: 100 }),
    ).rejects.toBeInstanceOf(ImageFetchError);
  });

  it('throws ImageDecodeError on an unrecognized type', async () => {
    mockFetchOnce({
      headers: { 'content-type': 'text/html' },
      body: new Uint8Array([0x3c, 0x21, 0x44, 0x4f]),
    });
    await expect(downloadImage('https://cdn/page')).rejects.toBeInstanceOf(
      ImageDecodeError,
    );
  });

  it('throws ImageDecodeError on an empty body', async () => {
    mockFetchOnce({ headers: { 'content-type': 'image/jpeg' } });
    await expect(downloadImage('https://cdn/empty')).rejects.toBeInstanceOf(
      ImageDecodeError,
    );
  });

  // SSRF guard (audit V1): customer-supplied URLs must never reach internal
  // hosts / cloud metadata. Literal private IPs are rejected before any fetch.
  it('throws ImageFetchError for the cloud-metadata IP (SSRF guard)', async () => {
    await expect(
      downloadImage('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toBeInstanceOf(ImageFetchError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws ImageFetchError for a loopback URL (SSRF guard)', async () => {
    await expect(
      downloadImage('http://127.0.0.1:3000/x'),
    ).rejects.toBeInstanceOf(ImageFetchError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('throws ImageFetchError for a non-http scheme (SSRF guard)', async () => {
    await expect(downloadImage('file:///etc/passwd')).rejects.toBeInstanceOf(
      ImageFetchError,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
