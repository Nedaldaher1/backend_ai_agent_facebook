import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { extname } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Disk } from 'flydrive';
import { FSDriver } from 'flydrive/drivers/fs';
import {
  ALLOWED_IMAGE_EXTENSIONS,
  UPLOAD_PUBLIC_PREFIX,
  resolveUploadDir,
} from './storage.constants';

/** Result of persisting one file: its storage key and public URL. */
export interface SavedImage {
  key: string;
  url: string;
}

/**
 * The ONLY place in the codebase that imports flydrive. Every other module talks
 * to storage through these three methods, so swapping the local `fs` driver for
 * S3/R2/GCS later is a config + driver change *here alone* — `saveImage`,
 * `getUrl`, `deleteImage`, and all of their callers stay identical.
 *
 * Driver is chosen by `STORAGE_DRIVER` (default `fs`). The fs driver writes to
 * `UPLOAD_DIR` (created on boot) and produces URLs of the form
 * `${PUBLIC_BASE_URL}/uploads/<key>`, served by @fastify/static (see main.ts).
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly driver: string;
  private readonly publicBaseUrl: string;
  private readonly disk: Disk;

  constructor(private readonly config: ConfigService) {
    this.driver = config.get<string>('STORAGE_DRIVER') ?? 'fs';
    this.publicBaseUrl = (
      config.get<string>('PUBLIC_BASE_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    this.disk = this.buildDisk();
  }

  /**
   * Persist a file's bytes under a freshly generated, collision-free key and
   * return that key plus the public URL produced by the active driver. Callers
   * store `url` verbatim; it stays valid as-is after a later driver swap.
   */
  async saveImage(buffer: Buffer, originalName: string): Promise<SavedImage> {
    const key = this.buildKey(originalName);
    await this.disk.put(key, buffer);
    const url = await this.disk.getUrl(key);
    return { key, url };
  }

  /** Public URL for a stored key, as produced by the active driver. */
  getUrl(key: string): Promise<string> {
    return this.disk.getUrl(key);
  }

  /** Remove a stored object by key. */
  async deleteImage(key: string): Promise<void> {
    await this.disk.delete(key);
  }

  // --- internals ---

  /**
   * Build a flydrive Disk for the configured driver. Adding S3/R2/GCS later is a
   * new `case` here (plus its env) — no method signature or caller changes.
   */
  private buildDisk(): Disk {
    switch (this.driver) {
      case 'fs': {
        const location = resolveUploadDir(
          this.config.get<string>('UPLOAD_DIR') ?? './uploads',
        );
        mkdirSync(location, { recursive: true });
        this.logger.log(`Storage driver "fs" -> ${location}`);
        return new Disk(
          new FSDriver({
            location,
            visibility: 'public',
            // The fs driver has no native URL support; generate the public URL
            // that @fastify/static serves so getUrl() returns a usable link.
            // flydrive types these as async, so resolve the synchronous result.
            urlBuilder: {
              generateURL: (key) => Promise.resolve(this.publicUrl(key)),
              generateSignedURL: (key) => Promise.resolve(this.publicUrl(key)),
            },
          }),
        );
      }
      default:
        throw new Error(
          `Unsupported STORAGE_DRIVER "${this.driver}". Only "fs" is implemented. ` +
            `Add the driver here (e.g. flydrive/drivers/s3) — callers need no changes.`,
        );
    }
  }

  /** `<uuid><safe-ext>` — never the raw upload name (path-traversal safe). */
  private buildKey(originalName: string): string {
    return `${randomUUID()}${this.safeExtension(originalName)}`;
  }

  /** Lower-cased extension, kept only if it is an allowed image type, else ''. */
  private safeExtension(originalName: string): string {
    const ext = extname(originalName).toLowerCase();
    return ALLOWED_IMAGE_EXTENSIONS.has(ext) ? ext : '';
  }

  /** `${PUBLIC_BASE_URL}/uploads/<key>`. */
  private publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${UPLOAD_PUBLIC_PREFIX}/${key}`;
  }
}
