import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '@/common/decorators/current-user.decorator';
import { ROLES_KEY } from '@/common/decorators/roles.decorator';

type AuthenticatedRequest = FastifyRequest & { user?: AuthUser };

/**
 * Authorization guard: checks that `request.user.role` (set by JwtAuthGuard)
 * is in the list declared with `@Roles(...)`. Must be composed AFTER
 * `JwtAuthGuard` so `request.user` is populated when this guard runs.
 *
 * If the handler or controller carries no `@Roles` metadata, the guard allows
 * the request through (open by default within an authenticated context).
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @Roles declared — allow any authenticated user.
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        `Role '${user?.role ?? 'unknown'}' is not authorized for this resource`,
      );
    }
    return true;
  }
}
