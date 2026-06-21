/**
 * Eval report (AIA-33): reads the logged agent eval rows
 * (messages.attributes.eval, written in M2) and prints descriptive metrics.
 *
 *   bun run eval:report
 *
 * DB only — does NOT call Claude, so it runs without a live model key.
 * Bootstraps a headless Nest application context to reuse the app's wiring.
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { ConversationsService } from '@/modules/conversations/conversations.service';
import {
  summarizeEvalRows,
  type EvalRow,
} from '@/modules/agent/eval/eval-metrics';

async function main(): Promise<void> {
  const logger = new Logger('eval:report');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const conversations = app.get(ConversationsService);
    const messages = await conversations.listAgentEvalRows(1000);
    const rows: EvalRow[] = messages
      .map((m) => (m.attributes as { eval?: EvalRow } | null)?.eval)
      .filter((e): e is EvalRow => Boolean(e));

    const summary = summarizeEvalRows(rows);
    logger.log(`eval rows found: ${rows.length}`);
    logger.log(JSON.stringify(summary, null, 2));
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error('eval:report failed:', err);
  process.exit(1);
});
