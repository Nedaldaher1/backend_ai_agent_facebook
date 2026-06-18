import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { RolesGuard } from '@/common/guards/roles.guard';

/**
 * Shared security wiring for protected (admin) routes. Registers `JwtModule`
 * once — with just the verification `secret` from the validated env, since the
 * guards only verify Bearer tokens (signing, which also needs `JWT_EXPIRES_IN`,
 * stays in AuthModule) — and provides + exports both guards.
 *
 * Any domain module that exposes guarded routes (products, knowledge, …) imports
 * `SecurityModule` instead of re-registering `JwtModule` and the guards, so the
 * JWT/guard setup lives in exactly one place. `JwtModule` is re-exported so
 * `JwtAuthGuard` resolves `JwtService` inside the importing module's injector.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers: [JwtAuthGuard, RolesGuard],
  exports: [JwtAuthGuard, RolesGuard, JwtModule],
})
export class SecurityModule {}
