/**
 * Unit tests for ManyChatSecretGuard.
 *
 * Validates:
 *  (a) secret set + matching header → canActivate returns true.
 *  (b) secret set + wrong header → throws UnauthorizedException.
 *  (c) secret set + missing header → throws UnauthorizedException.
 *  (d) secret NOT set → returns true (open-dev mode).
 *  (e) "warn once" invariant: the missing-secret warning fires exactly once
 *      even across multiple canActivate calls.
 *
 * No real HTTP, no NestJS DI — the guard is constructed directly with a stub
 * ConfigService and a fake ExecutionContext whose getRequest() returns a
 * Fastify-style headers object (all lowercase header keys, matching Fastify's
 * behaviour).
 */

import { UnauthorizedException } from '@nestjs/common';
import { ManyChatSecretGuard } from '../manychat-secret.guard';
import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

/** Build a stub ConfigService that returns the given map of env values. */
function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
}

/**
 * Build a fake Fastify-style ExecutionContext whose getRequest() returns a
 * request object with `headers` containing the given key-value pairs.
 * Fastify lowercases all header names, matching the production guard behaviour.
 */
function makeContext(headers: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ManyChatSecretGuard', () => {
  // -------------------------------------------------------------------------
  // (a) Secret set — matching header
  // -------------------------------------------------------------------------

  it('returns true when the secret is set and the header matches', () => {
    const guard = new ManyChatSecretGuard(
      makeConfig({ WEBHOOK_SHARED_SECRET: 'correct-secret' }),
    );
    const ctx = makeContext({ 'x-manychat-secret': 'correct-secret' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (b) Secret set — wrong header value
  // -------------------------------------------------------------------------

  it('throws UnauthorizedException when the secret is set and the header value is wrong', () => {
    const guard = new ManyChatSecretGuard(
      makeConfig({ WEBHOOK_SHARED_SECRET: 'correct-secret' }),
    );
    const ctx = makeContext({ 'x-manychat-secret': 'wrong-value' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  // -------------------------------------------------------------------------
  // (c) Secret set — header is missing
  // -------------------------------------------------------------------------

  it('throws UnauthorizedException when the secret is set and the header is absent', () => {
    const guard = new ManyChatSecretGuard(
      makeConfig({ WEBHOOK_SHARED_SECRET: 'correct-secret' }),
    );
    // No x-manychat-secret key in the headers object at all.
    const ctx = makeContext({});
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when the secret is set and the header is undefined', () => {
    const guard = new ManyChatSecretGuard(
      makeConfig({ WEBHOOK_SHARED_SECRET: 'correct-secret' }),
    );
    // Key present but value is explicitly undefined (Fastify can return this).
    const ctx = makeContext({ 'x-manychat-secret': undefined });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  // -------------------------------------------------------------------------
  // (d) Secret NOT set → open-dev mode, always returns true
  // -------------------------------------------------------------------------

  it('returns true when WEBHOOK_SHARED_SECRET is not set (open-dev mode)', () => {
    const guard = new ManyChatSecretGuard(
      makeConfig({}), // no WEBHOOK_SHARED_SECRET
    );
    const ctx = makeContext({});
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('returns true even with any header value when the secret is unset', () => {
    const guard = new ManyChatSecretGuard(
      makeConfig({ WEBHOOK_SHARED_SECRET: '' }), // empty string → treated as unset
    );
    const ctx = makeContext({ 'x-manychat-secret': 'anything' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (e) "warn once" invariant — missing-secret warning fires exactly once
  // -------------------------------------------------------------------------

  it('logs the missing-secret warning only once across multiple canActivate calls', () => {
    const guard = new ManyChatSecretGuard(makeConfig({}));

    // Spy on the guard's private logger (NestJS Logger is a prototype method).
    // Access via the guard instance directly — the property is set by the
    // decorator as `this.logger`.
    const loggerWarnSpy = jest
      .spyOn((guard as any).logger, 'warn')
      .mockImplementation(() => undefined);

    const ctx = makeContext({});
    guard.canActivate(ctx);
    guard.canActivate(ctx);
    guard.canActivate(ctx);

    // The warning must be emitted exactly once regardless of call count.
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);

    loggerWarnSpy.mockRestore();
  });
});
