import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema';

/**
 * Wraps @nestjs/config and validates env against env.schema.ts.
 * Global, so ConfigService is injectable everywhere without re-importing.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
  ],
})
export class AppConfigModule {}
