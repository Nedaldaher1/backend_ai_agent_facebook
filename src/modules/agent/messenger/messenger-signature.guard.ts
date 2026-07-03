/**
 * MessengerSignatureGuard — HMAC-SHA256 inbound authentication for the
 * POST /webhook/messenger route (Meta Messenger Platform, WS2).
 *
 * Meta sends `X-Hub-Signature-256: sha256=<lowercase-hex>` on every POST,
 * where <hex> = HMAC_SHA256(rawBody, MESSENGER_APP_SECRET).
 *
 * Behaviour:
 *  - Secret IS set → compute HMAC over req.rawBody and compare with
 *    timingSafeEqual (length-guarded). Missing/invalid header → 401.
 *  - Secret NOT set:
 *      · production  → FAIL CLOSED: reject with 401. Logged once.
 *      · non-prod    → log ONE warning and allow (dev/test without the secret).
 *
 * This guard is applied ONLY to the POST handler; the GET verification
 * endpoint is NOT signature-guarded (Meta does not send signatures on GETs).
 *
 * Raw body access: NestFactory must be bootstrapped with `rawBody: true` (the
 * NestJS built-in raw-body capture option) so that `req.rawBody` is populated
 * before the body-parser JSON conversion runs. See main.ts.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

const SIGNATURE_HEADER = 'x-hub-signature-256';
const SCHEME = 'sha256=';

@Injectable()
export class MessengerSignatureGuard implements CanActivate {
  private readonly logger = new Logger(MessengerSignatureGuard.name);
  private readonly appSecret: string | undefined;
  private readonly isProduction: boolean;
  /** Ensures the "no secret set" message is logged only once per server startup. */
  private warnedAboutMissingSecret = false;

  constructor(config: ConfigService) {
    this.appSecret = config.get<string>('MESSENGER_APP_SECRET') || undefined;
    this.isProduction = config.get<string>('NODE_ENV') === 'production';
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.appSecret) {
      this.warnMissingSecretOnce();
      if (this.isProduction) {
        throw new UnauthorizedException(
          'Messenger App Secret is not configured',
        );
      }
      return true;
    }

    const req = context
      .switchToHttp()
      .getRequest<FastifyRequest & { rawBody?: Buffer }>();

    const raw = req.headers[SIGNATURE_HEADER];
    // Only a single string header is valid; absent or duplicated (array) → fail.
    const providedHeader = typeof raw === 'string' ? raw : undefined;

    if (!providedHeader || !providedHeader.startsWith(SCHEME)) {
      throw new UnauthorizedException(
        'Missing or malformed X-Hub-Signature-256 header',
      );
    }

    const providedHex = providedHeader.slice(SCHEME.length);

    const rawBody = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      throw new UnauthorizedException(
        'Raw body unavailable for signature verification',
      );
    }

    if (!this.signatureMatches(rawBody, providedHex, this.appSecret)) {
      throw new UnauthorizedException('Invalid X-Hub-Signature-256 signature');
    }

    return true;
  }

  /**
   * Compute HMAC-SHA256 of the raw body and compare with the provided hex
   * using timingSafeEqual. Length-guards first (different-length strings cannot
   * be equal, and timingSafeEqual requires equal-length buffers).
   */
  private signatureMatches(
    rawBody: Buffer,
    providedHex: string,
    secret: string,
  ): boolean {
    const expectedHex = createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    const a = Buffer.from(providedHex, 'utf8');
    const b = Buffer.from(expectedHex, 'utf8');

    // Different lengths → definitely not equal (also avoids timingSafeEqual throw).
    if (a.length !== b.length) return false;

    return timingSafeEqual(a, b);
  }

  /** Log the missing-secret message exactly once (error in prod, warn in dev). */
  private warnMissingSecretOnce(): void {
    if (this.warnedAboutMissingSecret) return;
    this.warnedAboutMissingSecret = true;
    if (this.isProduction) {
      this.logger.error(
        'MESSENGER_APP_SECRET is not set in production — ALL Messenger webhook ' +
          'POST requests are rejected (401). Set it to enable HMAC signature validation.',
      );
    } else {
      this.logger.warn(
        'MESSENGER_APP_SECRET is not set — Messenger webhook POST signature ' +
          'validation is SKIPPED (dev only). Set this variable in production.',
      );
    }
  }
}
