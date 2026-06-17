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

describe('StorageService', () => {
  beforeEach(() => jest.clearAllMocks());

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
});
