import { isAbsolute, resolve } from 'node:path';

/**
 * Storage helpers that carry NO dependency on flydrive, so both the storage
 * service (which owns the driver) and the HTTP bootstrap (which mounts static
 * file serving) can share them without leaking the storage driver out of
 * `storage.service.ts`.
 */

/** URL/path segment locally stored files are served under: `/uploads/<key>`. */
export const UPLOAD_PUBLIC_PREFIX = 'uploads';

/** Image mimetypes the upload endpoint accepts. */
export const ALLOWED_IMAGE_MIME = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

/** Extensions kept when generating a storage key (lower-cased, dot-prefixed). */
export const ALLOWED_IMAGE_EXTENSIONS = new Set<string>([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
]);

/** Resolve a possibly-relative upload dir to an absolute path (CWD-based). */
export function resolveUploadDir(dir: string): string {
  return isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
}
