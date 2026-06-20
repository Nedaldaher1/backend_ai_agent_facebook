/**
 * One-off, idempotent embedding backfill: embeds every published product image
 * that isn't already embedded with the current model, then exits.
 *
 *   pnpm embeddings:backfill
 *
 * Safe to re-run — a second run skips everything and reports "nothing to do".
 * Bootstraps a headless Nest application context (no HTTP server) so it reuses
 * the exact ProductsService / EmbeddingService / storage wiring the app uses.
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { ProductsService } from '@/modules/products/products.service';

async function main(): Promise<void> {
  const logger = new Logger('embeddings:backfill');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const products = app.get(ProductsService);
    const summary = await products.backfillEmbeddings((msg) => logger.log(msg));
    logger.log(`summary: ${JSON.stringify(summary)}`);
    // Non-zero exit if any image failed, so CI/cron can notice.
    process.exitCode = summary.failed > 0 ? 1 : 0;
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
