/**
 * Unit tests for MessengerSignatureGuard.
 *
 * Covers:
 *  (a) Valid signature passes (secret set).
 *  (b) Tampered body → wrong signature → 401.
 *  (c) Missing X-Hub-Signature-256 header → 401.
 *  (d) Header present but missing sha256= scheme → 401.
 *  (e) Duplicated header (array) → 401.
 *  (f) Dev (no secret) → allows with one warning.
 *  (g) Prod (no secret) → 401 fail-closed.
 *  (h) Warn-once invariant: the "no secret" message fires exactly once.
 *  (i) rawBody absent → 401.
 *
 * No real HTTP, no NestJS DI — guard is constructed directly with stub
 * ConfigService. The fake ExecutionContext returns a Fastify-style request
 * with headers and rawBody.
 */

import { createHmac } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { MessengerSignatureGuard } from '../messenger-signature.guard';
import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

function makeContext(
  headers: Record<string, string | string[] | undefined>,
  rawBody?: Buffer,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers, rawBody }),
    }),
  } as unknown as ExecutionContext;
}

function buildSignature(body: Buffer, secret: string): string {
  const hex = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${hex}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const SECRET = 'test-app-secret-abc123';
const BODY = Buffer.from('{"object":"page","entry":[]}');
const VALID_SIG = buildSignature(BODY, SECRET);

describe('MessengerSignatureGuard', () => {
  // -------------------------------------------------------------------------
  // (a) Valid signature passes
  // -------------------------------------------------------------------------

  it('returns true when the secret is set and the HMAC signature matches', () => {
    const guard = new MessengerSignatureGuard(
      makeConfig({ MESSENGER_APP_SECRET: SECRET }),
    );
    const ctx = makeContext({ 'x-hub-signature-256': VALID_SIG }, BODY);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (b) Tampered body → wrong signature
  // -------------------------------------------------------------------------

  it('throws UnauthorizedException when the body was tampered (HMAC mismatch)', () => {
    const guard = new MessengerSignatureGuard(
      makeConfig({ MESSENGER_APP_SECRET: SECRET }),
    );
    // Send with the correct sig, but a different rawBody
    const tamperedBody = Buffer.from('{"object":"page","entry":[1]}');
    const ctx = makeContext({ 'x-hub-signature-256': VALID_SIG }, tamperedBody);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when the provided hex is wrong', () => {
    const guard = new MessengerSignatureGuard(
      makeConfig({ MESSENGER_APP_SECRET: SECRET }),
    );
    const ctx = makeContext(
      { 'x-hub-signature-256': 'sha256=' + 'a'.repeat(64) },
      BODY,
    );
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  // -------------------------------------------------------------------------
  // (c) Missing header → 401
  // -------------------------------------------------------------------------

  it('throws UnauthorizedException when the X-Hub-Signature-256 header is absent', () => {
    const guard = new MessengerSignatureGuard(
      makeConfig({ MESSENGER_APP_SECRET: SECRET }),
    );
    const ctx = makeContext({}, BODY);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throws when the header is explicitly undefined', () => {
    const guard = new MessengerSignatureGuard(
      makeConfig({ MESSENGER_APP_SECRET: SECRET }),
    );
    const ctx = makeContext({ 'x-hub-signature-256': undefined }, BODY);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  // -------------------------------------------------------------------------
  // (d) Header missing sha256= scheme
  // -------------------------------------------------------------------------

  it('throws when the header does not start with sha256=', () => {
    const guard = new MessengerSignatureGuard(
      makeConfig({ MESSENGER_APP_SECRET: SECRET }),
    );
    // Header value is valid hex but missing the scheme prefix
    const hex = createHmac('sha256', SECRET).update(BODY).digest('hex');
    const ctx = makeContext({ 'x-hub-signature-256': hex }, BODY);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  // -------------------------------------------------------------------------
  // (e) Duplicated header (array) → 401
  // -------------------------------------------------------------------------

  it('throws when the header is duplicated (array) even if one element is valid', () => {
    const guard = new MessengerSignatureGuard(
      makeConfig({ MESSENGER_APP_SECRET: SECRET }),
    );
    const ctx = makeContext(
      { 'x-hub-signature-256': [VALID_SIG, 'sha256=invalid'] },
      BODY,
    );
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  // -------------------------------------------------------------------------
  // (f) Dev (no secret) → allows with one warning
  // -------------------------------------------------------------------------

  it('returns true when MESSENGER_APP_SECRET is not set (dev open mode)', () => {
    const guard = new MessengerSignatureGuard(makeConfig({}));
    const ctx = makeContext({});
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('returns true even without credentials when secret is empty string (treated as unset)', () => {
    const guard = new MessengerSignatureGuard(
      makeConfig({ MESSENGER_APP_SECRET: '' }),
    );
    const ctx = makeContext({});
    expect(guard.canActivate(ctx)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (g) Prod (no secret) → 401 fail-closed
  // -------------------------------------------------------------------------

  it('throws (fail-closed) when secret is unset and NODE_ENV is production', () => {
    const guard = new MessengerSignatureGuard(
      makeConfig({ NODE_ENV: 'production' }),
    );
    const ctx = makeContext({});
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('allows when secret is unset and NODE_ENV is development', () => {
    const guard = new MessengerSignatureGuard(
      makeConfig({ NODE_ENV: 'development' }),
    );
    const ctx = makeContext({});
    expect(guard.canActivate(ctx)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (h) Warn-once invariant
  // -------------------------------------------------------------------------

  it('logs the missing-secret warning only once across multiple canActivate calls', () => {
    const guard = new MessengerSignatureGuard(makeConfig({}));

    const loggerWarnSpy = jest
      .spyOn((guard as unknown as { logger: { warn: jest.Mock } }).logger, 'warn')
      .mockImplementation(() => undefined);

    const ctx = makeContext({});
    guard.canActivate(ctx);
    guard.canActivate(ctx);
    guard.canActivate(ctx);

    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    loggerWarnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // (i) rawBody absent → 401
  // -------------------------------------------------------------------------

  it('throws when rawBody is absent even if the header is present', () => {
    const guard = new MessengerSignatureGuard(
      makeConfig({ MESSENGER_APP_SECRET: SECRET }),
    );
    // rawBody is undefined (not passed to makeContext)
    const ctx = makeContext({ 'x-hub-signature-256': VALID_SIG });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('throws when rawBody is an empty Buffer even if the header is present', () => {
    const guard = new MessengerSignatureGuard(
      makeConfig({ MESSENGER_APP_SECRET: SECRET }),
    );
    const ctx = makeContext({ 'x-hub-signature-256': VALID_SIG }, Buffer.alloc(0));
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
