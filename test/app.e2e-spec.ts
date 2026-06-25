import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';

/**
 * Boots the whole app over the Fastify adapter. Requires DATABASE_URL +
 * OPENROUTER_API_KEY in the environment and a reachable Postgres (the /health
 * route runs `select 1`). Not part of the default unit run (`bun run test`);
 * runs via `bun run test:e2e`.
 */
describe('Health (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  it('/health (GET) returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  afterAll(async () => {
    await app.close();
  });
});
