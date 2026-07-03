import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '@/common/decorators/roles.decorator';

/**
 * Build a minimal ExecutionContext stub. `requiredRoles` is what
 * @Roles(...) would have written into metadata; `userRole` is what
 * JwtAuthGuard would have placed on `request.user`.
 */
function makeContext(
  requiredRoles: string[] | undefined,
  userRole: string | undefined,
): ExecutionContext {
  const handler = jest.fn();
  const klass = jest.fn();
  const request = userRole !== undefined ? { user: { role: userRole } } : {};

  return {
    getHandler: () => handler,
    getClass: () => klass,
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let reflector: Reflector;
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  it('allows when the user role is in the required list', () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(['admin', 'editor']);

    const ctx = makeContext(['admin', 'editor'], 'admin');
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows editor role as well', () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(['admin', 'editor']);

    const ctx = makeContext(['admin', 'editor'], 'editor');
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws ForbiddenException when the user role is not in the required list', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);

    const ctx = makeContext(['admin'], 'editor');
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('throws ForbiddenException for a completely unknown role', () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(['admin', 'editor']);

    const ctx = makeContext(['admin', 'editor'], 'viewer');
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('allows when no @Roles metadata is present (open by default)', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

    // Even with a user whose role isn't 'admin', the guard should pass
    // because there is no @Roles requirement on this handler.
    const ctx = makeContext(undefined, 'viewer');
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows when @Roles metadata is an empty array', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([]);

    const ctx = makeContext([], 'admin');
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws ForbiddenException when request.user is absent and roles are required', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['admin']);

    const ctx = makeContext(['admin'], undefined);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('uses the ROLES_KEY constant for metadata lookup', () => {
    const spy = jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(['admin']);

    const ctx = makeContext(['admin'], 'admin');
    guard.canActivate(ctx);

    expect(spy).toHaveBeenCalledWith(
      ROLES_KEY,
      expect.arrayContaining([expect.any(Function), expect.any(Function)]),
    );
  });
});
