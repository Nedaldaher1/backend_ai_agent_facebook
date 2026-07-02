/**
 * Eval run (AIA-33): runs each labelled case in
 * src/modules/agent/eval/dataset/cases.json through the agent and scores the
 * matched products (precision/recall/hit), reporting per-case and total token
 * usage + estimated cost so optimization work has an objective before/after.
 *
 *   bun run eval:run
 *
 * REQUIRES a live OpenRouter key — the agent calls the model, so this cannot
 * run with a placeholder key. Exits non-zero when scored cases miss more than
 * half (a CI signal). Cases with an empty `expect.productIds` are run but not
 * scored.
 *
 * Contact ids are suffixed with a per-run id so every run starts fresh
 * conversations (comparable token counts, no dedup/thread bleed between runs).
 * Cases SHARING a base contactId still share one conversation within the run —
 * that is how multi-turn cases (follow-up references) are expressed.
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
import {
  cacheHitRate,
  estimateCostUsd,
  type TurnUsage,
} from '@/modules/agent/token-cost.util';

interface Dataset {
  note?: string;
  cases: EvalCase[];
}

// Read the dataset from source (not dist) so it works whether or not the JSON is
// copied into the build output. Scripts run from the project root.
const DATASET_PATH =
  process.env.EVAL_DATASET ??
  join(process.cwd(), 'src/modules/agent/eval/dataset/cases.json');

/** Model id the cost estimate is priced against (mirrors AgentService). */
const MODEL_ID =
  process.env.AGENT_MODEL_ID ?? 'openrouter/google/gemini-3.5-flash';

function formatUsage(
  usage: (TurnUsage & { steps?: number }) | undefined,
): string {
  if (!usage) return 'tokens=n/a';
  const cost = estimateCostUsd(MODEL_ID, usage);
  const rate = cacheHitRate(usage);
  return (
    `tokens(in=${usage.inputTokens ?? '?'}` +
    `${usage.cachedInputTokens ? ` cached=${usage.cachedInputTokens}` : ''}` +
    ` out=${usage.outputTokens ?? '?'} total=${usage.totalTokens ?? '?'}` +
    `${usage.steps !== undefined ? ` steps=${usage.steps}` : ''})` +
    `${cost !== undefined ? ` estCost=$${cost.toFixed(6)}` : ''}` +
    `${rate !== undefined ? ` cacheHit=${Math.round(rate * 100)}%` : ''}`
  );
}

async function main(): Promise<void> {
  const logger = new Logger('eval:run');
  const dataset = JSON.parse(readFileSync(DATASET_PATH, 'utf8')) as Dataset;

  // Fresh conversations every run — token counts stay comparable across runs.
  const runId = Date.now().toString(36);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const agent = app.get(AgentService);
    const results: CaseResult[] = [];
    const totals = { in: 0, cached: 0, out: 0, cost: 0, turns: 0 };

    for (const c of dataset.cases) {
      const reply = await agent.handleMessage({
        contactId: `${c.input.contactId}-${runId}`,
        text: c.input.text,
        lastImageUrl: c.input.lastImageUrl,
        adRef: c.input.adRef,
      });
      const productIds = (reply.products ?? []).map((p) => p.id);
      const score = scoreCase(c.expect, { productIds });
      results.push({ name: c.name, ...score });

      if (reply.usage) {
        totals.turns += 1;
        totals.in += reply.usage.inputTokens ?? 0;
        totals.cached += reply.usage.cachedInputTokens ?? 0;
        totals.out += reply.usage.outputTokens ?? 0;
        totals.cost += estimateCostUsd(MODEL_ID, reply.usage) ?? 0;
      }
      logger.log(
        `${c.name}: ${JSON.stringify(score)} ${formatUsage(reply.usage)}`,
      );
    }

    const agg = aggregateScores(results);
    logger.log(`aggregate: ${JSON.stringify(agg)}`);
    const avgCache =
      totals.in > 0 ? Math.round((totals.cached / totals.in) * 100) : 0;
    logger.log(
      `usage: turns=${totals.turns} totalIn=${totals.in} totalCached=${totals.cached} ` +
        `totalOut=${totals.out} totalEstCost=$${totals.cost.toFixed(6)} avgCacheHit=${avgCache}%`,
    );
    // CI signal: fail when scored cases hit less than half the time.
    process.exitCode = agg.scoredCases > 0 && agg.hitRate < 0.5 ? 1 : 0;
  } finally {
    await app.close();
    // Exit explicitly: lazily-built Mastra agents / the PostgresStore pool can
    // hold live handles past app.close() (observed after the triage tier's
    // first model call), leaving the script hanging after all cases finished.
    // All results are printed by now and exitCode is set — leave deliberately.
    process.exit(process.exitCode ?? 0);
  }
}

void main().catch((err: unknown) => {
  console.error('eval:run failed:', err);
  process.exit(1);
});
