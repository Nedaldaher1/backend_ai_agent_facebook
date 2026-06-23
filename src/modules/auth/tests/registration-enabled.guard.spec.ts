import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { RegistrationEnabledGuard } from '../registration-enabled.guard';

/** Build a guard whose ConfigService returns `value` for ALLOW_REGISTRATION. */
function makeGuard(value: string | undefined): RegistrationEnabledGuard {
  const config = {
    get: (key: string) => (key === 'ALLOW_REGISTRATION' ? value : undefined),
  } as unknown as ConfigService;
  return new RegistrationEnabledGuard(config);
}

// The guard ignores the execution context, so a bare object is sufficient.
const ctx = {} as ExecutionContext;

describe('RegistrationEnabledGuard', () => {
  it('allows the request when ALLOW_REGISTRATION is exactly "true"', () => {
    expect(makeGuard('true').canActivate(ctx)).toBe(true);
  });

  it('blocks with 403 when ALLOW_REGISTRATION is unset', () => {
    expect(() => makeGuard(undefined).canActivate(ctx)).toThrow(
      ForbiddenException,
    );
  });

  it('blocks with 403 when ALLOW_REGISTRATION is "false"', () => {
    expect(() => makeGuard('false').canActivate(ctx)).toThrow(
      ForbiddenException,
    );
  });

  it('blocks with 403 for any non-"true" value (no loose truthiness)', () => {
    for (const value of ['TRUE', 'True', '1', 'yes', 'on', '']) {
      expect(() => makeGuard(value).canActivate(ctx)).toThrow(
        ForbiddenException,
      );
    }
  });
});
