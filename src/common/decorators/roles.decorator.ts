import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key used by `RolesGuard` to read the required roles from the
 * handler or class decorator metadata.
 */
export const ROLES_KEY = 'roles';

/**
 * Declares which admin roles are allowed to access the decorated route or
 * controller. Works together with `RolesGuard` (which must run AFTER
 * `JwtAuthGuard` so that `request.user` is already populated).
 *
 * Usage:
 *   `@Roles('admin', 'editor')`
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
