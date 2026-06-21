import {
  aggregateScores,
  scoreCase,
  summarizeEvalRows,
  type CaseResult,
  type EvalRow,
} from '../eval-metrics';

describe('summarizeEvalRows', () => {
  const rows: EvalRow[] = [
    {
      tool: 'search_products',
      matched_product_ids: ['p1', 'p2'],
      image_led: false,
      confirmed: true,
    },
    {
      tool: 'find_similar_by_image',
      matched_product_ids: ['p3'],
      image_led: true,
      confirmed: null,
    },
    { tool: null, matched_product_ids: [], image_led: false, confirmed: false },
  ];

  it('counts turns, products, image-led and tool breakdown', () => {
    const s = summarizeEvalRows(rows);
    expect(s.totalTurns).toBe(3);
    expect(s.withProducts).toBe(2);
    expect(s.imageLed).toBe(1);
    expect(s.byTool).toEqual({
      search_products: 1,
      find_similar_by_image: 1,
      none: 1,
    });
  });

  it('buckets the confirmed flag', () => {
    const s = summarizeEvalRows(rows);
    expect(s.confirmedTrue).toBe(1);
    expect(s.confirmedFalse).toBe(1);
    expect(s.confirmedUnknown).toBe(1);
  });

  it('handles an empty input', () => {
    expect(summarizeEvalRows([]).totalTurns).toBe(0);
  });
});

describe('scoreCase', () => {
  it('computes precision/recall/hit against expected ids', () => {
    const r = scoreCase(
      { productIds: ['p1', 'p2'] },
      { productIds: ['p1', 'pX'] },
    );
    expect(r.scored).toBe(true);
    expect(r.precision).toBe(0.5); // 1 correct of 2 shown
    expect(r.recall).toBe(0.5); // 1 correct of 2 expected
    expect(r.hit).toBe(true);
  });

  it('reports a miss when nothing overlaps', () => {
    const r = scoreCase({ productIds: ['p1'] }, { productIds: ['pX'] });
    expect(r.hit).toBe(false);
    expect(r.recall).toBe(0);
  });

  it('is unscored when the case has no productIds expectation', () => {
    const r = scoreCase({ escalate: true }, { productIds: [] });
    expect(r.scored).toBe(false);
    expect(r.precision).toBeNull();
  });

  it('precision is 0 (not NaN) when nothing was shown', () => {
    const r = scoreCase({ productIds: ['p1'] }, { productIds: [] });
    expect(r.precision).toBe(0);
    expect(r.recall).toBe(0);
  });
});

describe('aggregateScores', () => {
  it('averages only scored cases and computes hit rate', () => {
    const results: CaseResult[] = [
      { name: 'a', precision: 1, recall: 1, hit: true, scored: true },
      { name: 'b', precision: 0, recall: 0, hit: false, scored: true },
      { name: 'c', precision: null, recall: null, hit: false, scored: false },
    ];
    const agg = aggregateScores(results);
    expect(agg.cases).toBe(3);
    expect(agg.scoredCases).toBe(2);
    expect(agg.hitRate).toBe(0.5);
    expect(agg.avgPrecision).toBe(0.5);
  });

  it('returns zeros for no scored cases', () => {
    const agg = aggregateScores([]);
    expect(agg.scoredCases).toBe(0);
    expect(agg.hitRate).toBe(0);
  });
});
