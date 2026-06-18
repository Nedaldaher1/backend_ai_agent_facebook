import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { extname } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Disk } from 'flydrive';
import { FSDriver } from 'flydrive/drivers/fs';
import { S3Driver } from 'flydrive/drivers/s3';
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
 * R2/GCS later is a config + driver change *here alone* — `saveImage`,
 * `getUrl`, `deleteImage`, and all of their callers stay identical.
 *
 * Driver is chosen by `STORAGE_DRIVER` (default `r2`).
 *   - 'fs': writes to `UPLOAD_DIR` (created on boot); serves via @fastify/static.
 *   - 'r2': uploads to Cloudflare R2 (S3-compatible); public URLs from R2_PUBLIC_URL.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly driver: string;
  private readonly publicBaseUrl: string;
  private readonly disk: Disk;

  constructor(private readonly config: ConfigService) {
    this.driver = config.get<string>('STORAGE_DRIVER') ?? 'r2';
    this.publicBaseUrl = (
      config.get<string>('PUBLIC_BASE_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    this.disk = this.buildDisk();
  }

  /**
   * Persist a file's bytes under a freshly generated, collision-free key and
   * return that key plus the public URL produced by the active driver. Callers
   * store `key` (not `url`) in the database; URLs are resolved on read via
   * `getUrl(key)` so the storage backend can change without a data migration.
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
   * Build a flydrive Disk for the configured driver. Adding GCS or a second
   * region is a new `case` here (plus its env) — no method signature or caller
   * changes.
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

      case 'r2': {
        // All R2_* vars are guaranteed present by env.schema.ts superRefine
        // (boot fails before this code runs if any are missing).
        const bucket = this.config.get<string>('R2_BUCKET')!;
        // flydrive's S3 driver resolves URLs with `new URL(key, cdnUrl)`, which
        // drops cdnUrl's last path segment unless it ends in a slash. Normalize
        // to exactly one trailing slash so getUrl(key) yields
        // `${R2_PUBLIC_URL}/${key}` and any subpath in R2_PUBLIC_URL is kept.
        const publicUrl = this.config
          .get<string>('R2_PUBLIC_URL')!
          .replace(/\/*$/, '/');

        this.logger.log(
          `Storage driver "r2" -> ${bucket} (public: ${publicUrl})`,
        );

        return new Disk(
          new S3Driver({
            credentials: {
              accessKeyId: this.config.get<string>('R2_ACCESS_KEY_ID')!,
              secretAccessKey: this.config.get<string>('R2_SECRET_ACCESS_KEY')!,
            },
            endpoint: this.config.get<string>('R2_ENDPOINT')!,
            region: this.config.get<string>('R2_REGION') ?? 'auto',
            bucket,
            // CRITICAL: R2 does not support S3 ACLs. Setting this to false
            // prevents the driver from sending ACL parameters that R2 rejects.
            supportsACL: false,
            visibility: 'public',
            // cdnUrl makes getUrl(key) resolve to the public R2 URL via
            // `new URL(key, publicUrl)`, never the internal S3 endpoint.
            cdnUrl: publicUrl,
          }),
        );
      }

      default:
        throw new Error(
          `Unsupported STORAGE_DRIVER "${this.driver}". Supported: "fs", "r2". ` +
            `Add the driver here — callers need no changes.`,
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

  /** `${PUBLIC_BASE_URL}/uploads/<key>` — used by the fs driver only. */
  private publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${UPLOAD_PUBLIC_PREFIX}/${key}`;
  }
}
