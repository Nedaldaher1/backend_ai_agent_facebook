import { SizingService, MAX_WEIGHT_KG } from '../sizing.service';
import type { SizeChartRepository } from '../size-chart.repository';

// Seeded rows in the same order the repository returns them: desc by min_weight.
const SEEDED_ROWS = [
  { id: 'id-2', minWeight: 90, size: '2', createdAt: new Date(), updatedAt: new Date() },
  { id: 'id-1', minWeight: 60, size: '1', createdAt: new Date(), updatedAt: new Date() },
];

describe('SizingService', () => {
  const findAllOrderedByMinWeightDesc = jest.fn();

  const repo = {
    findAllOrderedByMinWeightDesc,
  } as unknown as SizeChartRepository;

  const service = new SizingService(repo);

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: resolve the seeded chart.
    findAllOrderedByMinWeightDesc.mockResolvedValue(SEEDED_ROWS);
  });

  // -------------------------------------------------------------------------
  // In-range weights — positive path
  // -------------------------------------------------------------------------

  it('recommendSize(75) returns size "1"', async () => {
    const result = await service.recommendSize(75);
    expect(result).toEqual({ size: '1' });
  });

  it('recommendSize(89) returns size "1"', async () => {
    const result = await service.recommendSize(89);
    expect(result).toEqual({ size: '1' });
  });

  it('recommendSize(90) returns size "2" (exact lower-bound match)', async () => {
    const result = await service.recommendSize(90);
    expect(result).toEqual({ size: '2' });
  });

  it('recommendSize(100) returns size "2"', async () => {
    const result = await service.recommendSize(100);
    expect(result).toEqual({ size: '2' });
  });

  it(`recommendSize(${MAX_WEIGHT_KG}) returns size "2" (ceiling inclusive)`, async () => {
    const result = await service.recommendSize(MAX_WEIGHT_KG);
    expect(result).toEqual({ size: '2' });
  });

  // -------------------------------------------------------------------------
  // Out-of-range weights — escalation path
  // -------------------------------------------------------------------------

  it('recommendSize(130) returns null with needsHuman:true (above ceiling)', async () => {
    const result = await service.recommendSize(130);
    expect(result.size).toBeNull();
    expect(result.needsHuman).toBe(true);
    expect(result.note).toBeTruthy();
  });

  it('recommendSize(50) returns null with needsHuman:true (below floor)', async () => {
    const result = await service.recommendSize(50);
    expect(result.size).toBeNull();
    expect(result.needsHuman).toBe(true);
    expect(result.note).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Missing / invalid weight — clarification path (repo NOT queried)
  // -------------------------------------------------------------------------

  it('recommendSize(undefined) returns null with a note and needsHuman falsy; repo is not called', async () => {
    const result = await service.recommendSize(undefined);
    expect(result.size).toBeNull();
    expect(result.note).toBeTruthy();
    expect(result.needsHuman).toBeFalsy();
    expect(findAllOrderedByMinWeightDesc).not.toHaveBeenCalled();
  });

  it('recommendSize(0) returns clarification (not escalation); repo is not called', async () => {
    const result = await service.recommendSize(0);
    expect(result.size).toBeNull();
    expect(result.note).toBeTruthy();
    expect(result.needsHuman).toBeFalsy();
    expect(findAllOrderedByMinWeightDesc).not.toHaveBeenCalled();
  });

  it('recommendSize(NaN) returns clarification (not escalation); repo is not called', async () => {
    const result = await service.recommendSize(NaN);
    expect(result.size).toBeNull();
    expect(result.note).toBeTruthy();
    expect(result.needsHuman).toBeFalsy();
    expect(findAllOrderedByMinWeightDesc).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Empty chart — escalation path
  // -------------------------------------------------------------------------

  it('returns null with needsHuman:true when the chart is empty', async () => {
    findAllOrderedByMinWeightDesc.mockResolvedValue([]);

    const result = await service.recommendSize(75);
    expect(result.size).toBeNull();
    expect(result.needsHuman).toBe(true);
    expect(result.note).toBeTruthy();
  });
});
