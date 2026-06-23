import { mkdirSync } from 'node:fs';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { AppModule } from '@/app.module';
import { AllExceptionsFilter } from '@/common/filters/all-exceptions.filter';
import { DOCS_ROUTE, setupOpenApi } from '@/core/openapi/openapi';
import {
  UPLOAD_PUBLIC_PREFIX,
  resolveUploadDir,
} from '@/core/storage/storage.constants';

async function bootstrap() {
  // rawBody: true — enables NestJS's built-in raw-body capture for Fastify.
  // The Fastify adapter registers a JSON content-type parser that, when this
  // option is true, copies the raw Buffer to req.rawBody BEFORE the parsed
  // JSON lands in req.body. Required for MessengerSignatureGuard to validate
  // the X-Hub-Signature-256 HMAC (HMAC must be computed over the raw bytes).
  // See: @nestjs/platform-fastify FastifyAdapter.registerJsonContentParser.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
    { rawBody: true },
  );
  const config = app.get(ConfigService);

  // Security & transport plugins (Fastify-native).
  await app.register(helmet);
  await app.register(compress);

  // CORS — let the admin panel call the API from its browser origin.
  // Allowed origins come from CORS_ORIGINS (comma-separated). In non-production we
  // also accept any localhost / 127.0.0.1 port, so the Vite dev server (5173, 5174,
  // …) works without extra config. `methods` MUST be set explicitly: @fastify/cors
  // (what NestJS registers under the hood) defaults to `GET,HEAD,POST`, which would
  // block the admin PATCH/PUT/DELETE routes with a CORS error.
  const corsOrigins: (string | RegExp)[] = (config.get<string>('CORS_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (config.get<string>('NODE_ENV') !== 'production') {
    corsOrigins.push(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/);
  }
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // File uploads: parsed in-memory (no temp files) and capped by env. The buffer
  // is handed to StorageService, which owns the storage driver (flydrive).
  await app.register(multipart, {
    limits: {
      fileSize: config.get<number>('UPLOAD_MAX_BYTES') ?? 5 * 1024 * 1024,
      files: 20,
    },
  });

  // Serve locally stored files at `/uploads/<key>` — the same URLs StorageService
  // records on products. After a swap to cloud storage those URLs point at the
  // bucket instead and this mount simply goes unused; no code changes needed.
  const uploadDir = resolveUploadDir(
    config.get<string>('UPLOAD_DIR') ?? './uploads',
  );
  mkdirSync(uploadDir, { recursive: true }); // StorageService also ensures this
  await app.register(fastifyStatic, {
    root: uploadDir,
    prefix: `/${UPLOAD_PUBLIC_PREFIX}/`,
    decorateReply: false,
    // Let the separate-origin admin panel render images despite helmet's
    // default same-origin resource policy.
    setHeaders: (res) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    },
  });

  // class-validator DTOs go through this; zod DTOs use ZodValidationPipe per-route.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  // Scalar API docs at /docs (built from the controllers/DTOs; spec at
  // /docs/openapi.json). Registered before listen so the Fastify plugin mounts.
  await setupOpenApi(app);

  const port = config.get<number>('PORT') ?? 3000;

  // Bind to 0.0.0.0 — required to reach the server from Windows under WSL.
  await app.listen(port, '0.0.0.0');
  const logger = new Logger('Bootstrap');
  logger.log(`Masa backend listening on http://0.0.0.0:${port}`);
  logger.log(`API docs (Scalar) at http://0.0.0.0:${port}${DOCS_ROUTE}`);
}

void bootstrap();
