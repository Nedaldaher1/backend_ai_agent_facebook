/**
 * ManyChatSecretGuard — shared-secret inbound authentication for the ManyChat
 * webhook routes (WS4b).
 *
 * Reads the `x-manychat-secret` request header and compares it against
 * `WEBHOOK_SHARED_SECRET` from ConfigService.
 *
 * Behaviour:
 *  - Secret IS set   → header must match; missing or wrong header → 401.
 *  - Secret NOT set  → guard logs ONE warning per startup and allows the request
 *                      so local dev never breaks (no env var needed in dev).
 *
 * A guard rejection is HTTP 401 (4xx), NOT 5xx — this is acceptable; it only
 * fires for genuinely unauthorized callers, not for normal ManyChat traffic.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';

const HEADER = 'x-manychat-secret';

@Injectable()
export class ManyChatSecretGuard implements CanActivate {
  private readonly logger = new Logger(ManyChatSecretGuard.name);
  private readonly secret: string | undefined;
  /** Ensures the "no secret set" warning is logged only once per server startup. */
  private warnedAboutMissingSecret = false;

  constructor(private readonly config: ConfigService) {
    this.secret = config.get<string>('WEBHOOK_SHARED_SECRET') || undefined;
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.secret) {
      if (!this.warnedAboutMissingSecret) {
        this.logger.warn(
          'WEBHOOK_SHARED_SECRET is not set — ManyChat webhook is open to any caller. ' +
            'Set this variable in production to enable shared-secret auth.',
        );
        this.warnedAboutMissingSecret = true;
      }
      // Dev mode: allow without a secret.
      return true;
    }

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const provided = req.headers[HEADER];

    if (provided !== this.secret) {
      throw new UnauthorizedException('Invalid ManyChat shared secret');
    }

    return true;
  }
}
