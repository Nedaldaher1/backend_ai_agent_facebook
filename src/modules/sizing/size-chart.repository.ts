import { Inject, Injectable } from '@nestjs/common';
import { asc, desc } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { sizeChart, type SizeChartRow } from './entities/size-chart.entity';

/**
 * Read-only access to the size_chart control-plane table.
 * All query building is done through Drizzle's typed API — no raw SQL strings.
 */
@Injectable()
export class SizeChartRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * Returns every size band ordered by min_weight descending so that the
   * service can walk the list with a simple Array.find() to pick the
   * greatest threshold ≤ customer weight.
   */
  async findAllOrderedByMinWeightDesc(): Promise<SizeChartRow[]> {
    return this.db
      .select()
      .from(sizeChart)
      .orderBy(desc(sizeChart.minWeight));
  }

  /**
   * Distinct size codes configured in the chart (e.g. '1', '2'), ascending.
   * Source for the closed-enum size vocabulary in vision attribute extraction.
   */
  async distinctSizes(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ size: sizeChart.size })
      .from(sizeChart)
      .orderBy(asc(sizeChart.size));
    return rows.map((r) => r.size);
  }
}
