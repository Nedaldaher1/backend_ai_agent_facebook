/**
 * Unit tests for the SSRF guard (audit V1).
 *
 * Customer-supplied image URLs are fetched server-side (vision pre-step + visual
 * search). assertPublicHttpUrl must reject internal/loopback/link-local targets
 * and the cloud-metadata endpoint, while allowing genuine public CDN URLs.
 */

import { lookup } from 'node:dns/promises';
import {
  assertPublicHttpUrl,
  isPrivateOrReservedIp,
  UnsafeUrlError,
} from './url-safety';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
const mockLookup = lookup as unknown as jest.Mock;

describe('isPrivateOrReservedIp', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '0.0.0.0',
    '100.64.0.1', // CGNAT
    '224.0.0.1', // multicast
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
  ])('flags %s as private/reserved', (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '93.184.216.34',
    '2606:4700::1111',
  ])('allows public %s', (ip) => {
    expect(isPrivateOrReservedIp(ip)).toBe(false);
  });

  it('returns false for a non-IP string', () => {
    expect(isPrivateOrReservedIp('not-an-ip')).toBe(false);
  });
});

describe('assertPublicHttpUrl', () => {
  beforeEach(() => mockLookup.mockReset());

  it('rejects non-http(s) schemes', async () => {
    await expect(
      assertPublicHttpUrl('file:///etc/passwd'),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpUrl('ftp://host/x')).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it('rejects an unparseable URL', async () => {
    await expect(assertPublicHttpUrl('not a url')).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it('rejects localhost without a DNS lookup', async () => {
    await expect(
      assertPublicHttpUrl('http://localhost/x'),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('rejects private / metadata / loopback IP literals without DNS', async () => {
    await expect(
      assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/'),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(
      assertPublicHttpUrl('http://127.0.0.1:3000/'),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(
      assertPublicHttpUrl('http://10.1.2.3/'),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpUrl('http://[::1]/')).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('allows a public IP literal without DNS', async () => {
    await expect(
      assertPublicHttpUrl('https://8.8.8.8/x.jpg'),
    ).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('allows a named host that resolves to a public address', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(
      assertPublicHttpUrl('https://cdn.example.com/a.jpg'),
    ).resolves.toBeUndefined();
    expect(mockLookup).toHaveBeenCalledWith('cdn.example.com', { all: true });
  });

  it('rejects a named host that resolves to a private address (DNS rebinding)', async () => {
    mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(
      assertPublicHttpUrl('https://evil.example.com/a.jpg'),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects when the host cannot be resolved', async () => {
    mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      assertPublicHttpUrl('https://nope.invalid/a.jpg'),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});
