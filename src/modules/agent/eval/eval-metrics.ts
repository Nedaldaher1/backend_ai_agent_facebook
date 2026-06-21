/**
 * Pure metrics for the evals harness (AIA-33).
 *
 *  - `summarizeEvalRows` describes what actually happened in production from the
 *    logged `messages.attributes.eval` rows (M2) — no ground truth needed.
 *  - `scoreCase` / `aggregateScores` score the agent's matched products against a
 *    labelled eval case (the `eval-run` script feeds these).
 *
 * No I/O here so everything is unit tested; the scripts own DB / agent access.
 */

/** The eval payload persisted on an agent turn (messages.attributes.eval). */
export interface EvalRow {
  tool: 'search_products' | 'find_similar_by_image' | null;
  matched_product_ids: string[];
  image_led: boolean;
  confirmed: boolean | null;
  search_params?: unknown;
}

export interface EvalSummary {
  totalTurns: number;
  withProducts: number;
  imageLed: number;
  byTool: Record<string, number>;
  confirmedTrue: number;
  confirmedFalse: number;
  confirmedUnknown: number;
}

/** Descriptive stats over logged eval rows (production behavior, no labels). */
export function summarizeEvalRows(rows: EvalRow[]): EvalSummary {
  const summary: EvalSummary = {
    totalTurns: rows.length,
    withProducts: 0,
    imageLed: 0,
    byTool: {},
    confirmedTrue: 0,
    confirmedFalse: 0,
    confirmedUnknown: 0,
  };
  for (const r of rows) {
    if (r.matched_product_ids?.length > 0) summary.withProducts++;
    if (r.image_led) summary.imageLed++;
    const tool = r.tool ?? 'none';
    summary.byTool[tool] = (summary.byTool[tool] ?? 0) + 1;
    if (r.confirmed === true) summary.confirmedTrue++;
    else if (r.confirmed === false) summary.confirmedFalse++;
    else summary.confirmedUnknown++;
  }
  return summary;
}

/** A labelled eval case: an input turn + the expected outcome. */
export interface EvalCase {
  name: string;
  input: {
    contactId: string;
    text: string;
    lastImageUrl?: string;
    adRef?: string;
  };
  expect: { productIds?: string[]; escalate?: boolean };
}

/** Scoring of one case against the agent's actual matched products. */
export interface CaseResult {
  name: string;
  /** null when the case has no productIds expectation. */
  precision: number | null;
  recall: number | null;
  /** At least one expected id surfaced (only meaningful with expectations). */
  hit: boolean;
  scored: boolean;
}

/**
 * Score matched products against an expectation. Precision = correct / shown,
 * recall = correct / expected. A case with no `productIds` expectation is not
 * scored (precision/recall null, scored=false).
 */
export function scoreCase(
  expected: EvalCase['expect'],
  actual: { productIds: string[] },
): Omit<CaseResult, 'name'> {
  const exp = expected.productIds ?? [];
  if (exp.length === 0) {
    return { precision: null, recall: null, hit: false, scored: false };
  }
  const expSet = new Set(exp);
  const shown = actual.productIds ?? [];
  const correct = shown.filter((id) => expSet.has(id)).length;
  return {
    precision: shown.length > 0 ? correct / shown.length : 0,
    recall: correct / exp.length,
    hit: correct > 0,
    scored: true,
  };
}

export interface AggregateScore {
  cases: number;
  scoredCases: number;
  hitRate: number;
  avgPrecision: number;
  avgRecall: number;
}

/** Aggregate scored cases (cases without expectations are excluded from rates). */
export function aggregateScores(results: CaseResult[]): AggregateScore {
  const scored = results.filter((r) => r.scored);
  const n = scored.length;
  const sum = (pick: (r: CaseResult) => number) =>
    scored.reduce((acc, r) => acc + pick(r), 0);
  return {
    cases: results.length,
    scoredCases: n,
    hitRate: n > 0 ? scored.filter((r) => r.hit).length / n : 0,
    avgPrecision: n > 0 ? sum((r) => r.precision ?? 0) / n : 0,
    avgRecall: n > 0 ? sum((r) => r.recall ?? 0) / n : 0,
  };
}
