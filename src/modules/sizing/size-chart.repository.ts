import { Inject, Injectable } from '@nestjs/common';
import { desc } from 'drizzle-orm';
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
}
