import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Gates POST /auth/register behind the ALLOW_REGISTRATION env flag.
 *
 * Admin self-registration is CLOSED by default — the guard allows the request
 * only when ALLOW_REGISTRATION is exactly 'true'. Open it to bootstrap the first
 * admin (there is no seed mechanism), then set it back to keep the endpoint shut.
 * Any other value (including unset) → 403.
 *
 * The flag is read once at startup (constructor), so toggling it requires a
 * restart — acceptable for a deliberate bootstrap switch, and it avoids reading
 * config on every request.
 */
@Injectable()
export class RegistrationEnabledGuard implements CanActivate {
  private readonly enabled: boolean;

  constructor(config: ConfigService) {
    this.enabled = config.get<string>('ALLOW_REGISTRATION') === 'true';
  }

  canActivate(_context: ExecutionContext): boolean {
    if (!this.enabled) {
      throw new ForbiddenException(
        'Admin self-registration is disabled. Set ALLOW_REGISTRATION=true to ' +
          'bootstrap the first admin, then turn it back off.',
      );
    }
    return true;
  }
}
