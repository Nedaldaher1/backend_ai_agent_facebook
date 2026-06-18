// flydrive + node:fs are mocked so the service can be exercised without a real
// disk. Spies are created inside the factories (jest hoists jest.mock above the
// imports) and exposed for assertions.
jest.mock('node:fs', () => ({
  ...jest.requireActual<typeof import('node:fs')>('node:fs'),
  mkdirSync: jest.fn(),
}));

jest.mock('flydrive/drivers/fs', () => ({
  __esModule: true,
  FSDriver: jest
    .fn()
    .mockImplementation((options: { urlBuilder: unknown }) => ({
      urlBuilder: options.urlBuilder,
      options,
    })),
}));

// S3Driver mock: capture constructor args for assertion, and mirror the REAL
// driver's getUrl, which resolves `new URL(key, cdnUrl)` (not a string concat) —
// so the test would catch a regression in how cdnUrl is normalized.
let s3ConstructorArgs: Record<string, unknown> | undefined;
jest.mock('flydrive/drivers/s3', () => ({
  __esModule: true,
  S3Driver: jest.fn().mockImplementation((options: Record<string, unknown>) => {
    s3ConstructorArgs = options;
    const cdnUrl = options.cdnUrl as string | undefined;
    const toUrl = (key: string) =>
      Promise.resolve(
        cdnUrl ? new URL(key, cdnUrl).toString() : `s3-endpoint/${key}`,
      );
    return {
      options,
      urlBuilder: { generateURL: toUrl, generateSignedURL: toUrl },
    };
  }),
}));

jest.mock('flydrive', () => {
  const put = jest.fn().mockResolvedValue(undefined);
  const remove = jest.fn().mockResolvedValue(undefined);
  return {
    __esModule: true,
    Disk: jest
      .fn()
      .mockImplementation(
        (driver: { urlBuilder: { generateURL: (k: string) => string } }) => ({
          put,
          delete: remove,
          getUrl: (key: string) =>
            Promise.resolve(driver.urlBuilder.generateURL(key)),
        }),
      ),
    __spies: { put, remove },
  };
});

import type { ConfigService } from '@nestjs/config';
import * as flydrive from 'flydrive';
import { StorageService } from '../storage.service';

const { put, remove } = (
  flydrive as unknown as {
    __spies: { put: jest.Mock; remove: jest.Mock };
  }
).__spies;

const UUID = /^[0-9a-f-]{36}/i;

const makeConfig = (overrides: Record<string, unknown> = {}): ConfigService =>
  ({
    get: (key: string) =>
      ({
        STORAGE_DRIVER: 'fs',
        UPLOAD_DIR: './uploads',
        PUBLIC_BASE_URL: 'http://localhost:3000',
        ...overrides,
      })[key],
  }) as unknown as ConfigService;

/** Config factory for the R2 driver with sane test defaults. */
const makeR2Config = (overrides: Record<string, unknown> = {}): ConfigService =>
  makeConfig({
    STORAGE_DRIVER: 'r2',
    R2_ACCESS_KEY_ID: 'test-key-id',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_ENDPOINT: 'https://account123.r2.cloudflarestorage.com',
    R2_BUCKET: 'masa-images',
    R2_PUBLIC_URL: 'https://pub.example.com',
    R2_REGION: 'auto',
    ...overrides,
  });

describe('StorageService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    s3ConstructorArgs = undefined;
  });

  // --- fs driver (existing tests, kept) ---

  it('saves under a uuid + sanitized extension key and returns its public URL', async () => {
    const service = new StorageService(makeConfig());

    const { key, url } = await service.saveImage(Buffer.from('x'), 'Photo.JPG');

    expect(key).toMatch(/^[0-9a-f-]{36}\.jpg$/i);
    expect(put).toHaveBeenCalledWith(key, expect.any(Buffer));
    expect(url).toBe(`http://localhost:3000/uploads/${key}`);
  });

  it('keeps .jpeg/.png/.webp but drops a disallowed extension', async () => {
    const service = new StorageService(makeConfig());

    expect((await service.saveImage(Buffer.from('x'), 'a.png')).key).toMatch(
      /\.png$/,
    );
    expect((await service.saveImage(Buffer.from('x'), 'a.webp')).key).toMatch(
      /\.webp$/,
    );
    // Disallowed extension is stripped — just the uuid remains.
    expect(
      (await service.saveImage(Buffer.from('x'), 'malware.svg')).key,
    ).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('never derives the key from a path-traversal filename', async () => {
    const service = new StorageService(makeConfig());

    const { key } = await service.saveImage(
      Buffer.from('x'),
      '../../../etc/passwd',
    );

    expect(key).toMatch(UUID);
    expect(key).not.toContain('/');
    expect(key).not.toContain('..');
  });

  it('strips a trailing slash from PUBLIC_BASE_URL when building URLs', async () => {
    const service = new StorageService(
      makeConfig({ PUBLIC_BASE_URL: 'http://cdn.example.com/' }),
    );

    expect(await service.getUrl('abc.png')).toBe(
      'http://cdn.example.com/uploads/abc.png',
    );
  });

  it('deletes by key through the driver', async () => {
    const service = new StorageService(makeConfig());

    await service.deleteImage('abc.png');

    expect(remove).toHaveBeenCalledWith('abc.png');
  });

  it('throws for an unimplemented driver (fails fast at boot)', () => {
    expect(
      () => new StorageService(makeConfig({ STORAGE_DRIVER: 's3' })),
    ).toThrow(/Unsupported STORAGE_DRIVER/);
  });

  // --- r2 driver ---

  it('r2: getUrl returns ${R2_PUBLIC_URL}/${key} (public-URL shape)', async () => {
    const service = new StorageService(makeR2Config());

    const url = await service.getUrl('abc.jpg');

    expect(url).toBe('https://pub.example.com/abc.jpg');
  });

  it('r2: URL is NOT the S3 endpoint', async () => {
    const service = new StorageService(makeR2Config());

    const url = await service.getUrl('abc.jpg');

    expect(url).not.toContain('r2.cloudflarestorage.com');
  });

  it('r2: saveImage uploads and returns public URL from R2_PUBLIC_URL', async () => {
    const service = new StorageService(makeR2Config());

    const { key, url } = await service.saveImage(
      Buffer.from('img'),
      'photo.jpg',
    );

    expect(key).toMatch(/^[0-9a-f-]{36}\.jpg$/i);
    expect(put).toHaveBeenCalledWith(key, expect.any(Buffer));
    expect(url).toBe(`https://pub.example.com/${key}`);
  });

  it('r2: S3Driver is constructed with supportsACL: false (no ACL params)', () => {
    new StorageService(makeR2Config());

    expect(s3ConstructorArgs).toBeDefined();
    expect(s3ConstructorArgs!['supportsACL']).toBe(false);
  });

  it('r2: normalizes a trailing slash on R2_PUBLIC_URL', async () => {
    const service = new StorageService(
      makeR2Config({ R2_PUBLIC_URL: 'https://pub.example.com/' }),
    );

    const url = await service.getUrl('img.png');

    expect(url).toBe('https://pub.example.com/img.png');
  });

  it('r2: preserves a subpath in R2_PUBLIC_URL', async () => {
    const service = new StorageService(
      makeR2Config({ R2_PUBLIC_URL: 'https://pub.example.com/cdn' }),
    );

    expect(await service.getUrl('img.png')).toBe(
      'https://pub.example.com/cdn/img.png',
    );
  });

  it('r2: S3Driver receives the correct endpoint and region', () => {
    new StorageService(makeR2Config());

    expect(s3ConstructorArgs!['endpoint']).toBe(
      'https://account123.r2.cloudflarestorage.com',
    );
    expect(s3ConstructorArgs!['region']).toBe('auto');
  });
});
