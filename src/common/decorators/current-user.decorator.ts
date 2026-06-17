import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/** Decoded admin JWT payload that `JwtAuthGuard` attaches to the request. */
export interface AuthUser {
  sub: string;
  email: string;
  role: string;
}

type AuthenticatedRequest = FastifyRequest & { user?: AuthUser };

/**
 * Injects the authenticated admin (the decoded JWT payload) into a handler.
 * Only meaningful on routes guarded by `JwtAuthGuard`, which populates
 * `request.user`.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user!;
  },
);
