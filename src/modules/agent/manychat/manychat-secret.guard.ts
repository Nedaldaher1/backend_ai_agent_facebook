/**
 * ManyChatSecretGuard — shared-secret inbound authentication for the ManyChat
 * webhook routes (WS4b).
 *
 * Reads the `x-manychat-secret` request header and compares it against
 * `WEBHOOK_SHARED_SECRET` from ConfigService using a constant-time comparison.
 *
 * Behaviour:
 *  - Secret IS set      → header must match; missing/wrong/duplicated → 401.
 *  - Secret NOT set:
 *      · production     → FAIL CLOSED: reject with 401 (a missing secret must
 *                          never silently open the public webhook). Logged once.
 *      · non-production → log ONE warning and allow, so local dev never needs
 *                          the env var.
 *
 * A guard rejection is HTTP 401 (4xx), NOT 5xx — acceptable; it only fires for
 * unauthorized callers or a prod misconfiguration, not for normal traffic.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

const HEADER = 'x-manychat-secret';

@Injectable()
export class ManyChatSecretGuard implements CanActivate {
  private readonly logger = new Logger(ManyChatSecretGuard.name);
  private readonly secret: string | undefined;
  private readonly isProduction: boolean;
  /** Ensures the "no secret set" message is logged only once per server startup. */
  private warnedAboutMissingSecret = false;

  constructor(config: ConfigService) {
    this.secret = config.get<string>('WEBHOOK_SHARED_SECRET') || undefined;
    this.isProduction = config.get<string>('NODE_ENV') === 'production';
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.secret) {
      this.warnMissingSecretOnce();
      // Fail closed in production; allow in dev so no env var is needed locally.
      if (this.isProduction) {
        throw new UnauthorizedException('ManyChat webhook secret is not configured');
      }
      return true;
    }

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const raw = req.headers[HEADER];
    // Only a single string header is valid; an absent or duplicated (array)
    // header fails closed.
    const provided = typeof raw === 'string' ? raw : undefined;

    if (!provided || !this.secretsMatch(provided, this.secret)) {
      throw new UnauthorizedException('Invalid ManyChat shared secret');
    }

    return true;
  }

  /** Constant-time comparison; a length mismatch short-circuits to false. */
  private secretsMatch(provided: string, expected: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Log the missing-secret message exactly once (error in prod, warn in dev). */
  private warnMissingSecretOnce(): void {
    if (this.warnedAboutMissingSecret) return;
    this.warnedAboutMissingSecret = true;
    if (this.isProduction) {
      this.logger.error(
        'WEBHOOK_SHARED_SECRET is not set in production — ALL ManyChat webhook ' +
          'requests are rejected (401). Set it to enable shared-secret auth.',
      );
    } else {
      this.logger.warn(
        'WEBHOOK_SHARED_SECRET is not set — ManyChat webhook is open to any ' +
          'caller (dev only). Set this variable in production.',
      );
    }
  }
}
