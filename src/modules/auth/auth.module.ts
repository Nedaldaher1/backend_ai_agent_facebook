import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, type JwtSignOptions } from '@nestjs/jwt';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { AdminModule } from '@/modules/admin/admin.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RegistrationEnabledGuard } from './registration-enabled.guard';

/**
 * Admin authentication. Reuses AdminModule's `AdminUsersService` for account
 * persistence and configures `JwtModule` from the validated env
 * (`JWT_SECRET` / `JWT_EXPIRES_IN`).
 */
@Module({
  imports: [
    AdminModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: {
          // JWT_EXPIRES_IN is a validated duration string (e.g. '7d'); cast to the
          // ms-based literal type @nestjs/jwt expects for a runtime string value.
          expiresIn: (config.get<string>('JWT_EXPIRES_IN') ??
            '7d') as JwtSignOptions['expiresIn'],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RegistrationEnabledGuard],
})
export class AuthModule {}
