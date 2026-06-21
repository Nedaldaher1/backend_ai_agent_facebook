/**
 * Eval run (AIA-33): runs each labelled case in
 * src/modules/agent/eval/dataset/cases.json through the agent and scores the
 * matched products (precision/recall/hit).
 *
 *   bun run eval:run
 *
 * REQUIRES a live Claude key — the agent calls the model, so this cannot run with
 * a placeholder key. Exits non-zero when scored cases miss more than half (a CI
 * signal). Cases with an empty `expect.productIds` are run but not scored.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { AgentService } from '@/modules/agent/agent.service';
import {
  aggregateScores,
  scoreCase,
  type CaseResult,
  type EvalCase,
} from '@/modules/agent/eval/eval-metrics';

interface Dataset {
  note?: string;
  cases: EvalCase[];
}

// Read the dataset from source (not dist) so it works whether or not the JSON is
// copied into the build output. Scripts run from the project root.
const DATASET_PATH =
  process.env.EVAL_DATASET ??
  join(process.cwd(), 'src/modules/agent/eval/dataset/cases.json');

async function main(): Promise<void> {
  const logger = new Logger('eval:run');
  const dataset = JSON.parse(readFileSync(DATASET_PATH, 'utf8')) as Dataset;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const agent = app.get(AgentService);
    const results: CaseResult[] = [];

    for (const c of dataset.cases) {
      const reply = await agent.handleMessage({
        contactId: c.input.contactId,
        text: c.input.text,
        lastImageUrl: c.input.lastImageUrl,
        adRef: c.input.adRef,
      });
      const productIds = (reply.products ?? []).map((p) => p.id);
      const score = scoreCase(c.expect, { productIds });
      results.push({ name: c.name, ...score });
      logger.log(`${c.name}: ${JSON.stringify(score)}`);
    }

    const agg = aggregateScores(results);
    logger.log(`aggregate: ${JSON.stringify(agg)}`);
    // CI signal: fail when scored cases hit less than half the time.
    process.exitCode = agg.scoredCases > 0 && agg.hitRate < 0.5 ? 1 : 0;
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error('eval:run failed:', err);
  process.exit(1);
});
