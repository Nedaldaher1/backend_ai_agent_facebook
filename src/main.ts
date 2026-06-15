import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );

  // Security & transport plugins (Fastify-native).
  await app.register(helmet);
  await app.register(compress);
  app.enableCors({ origin: true, credentials: true });

  // class-validator DTOs go through this; zod DTOs use ZodValidationPipe per-route.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT') ?? 3000;

  // Bind to 0.0.0.0 — required to reach the server from Windows under WSL.
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(
    `Masa backend listening on http://0.0.0.0:${port}`,
  );
}

void bootstrap();
