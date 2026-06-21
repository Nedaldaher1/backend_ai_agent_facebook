import { Module } from '@nestjs/common';
import { SizeChartRepository } from './size-chart.repository';
import { SizingService } from './sizing.service';

/**
 * Sizing domain module.
 *
 * DatabaseModule is @Global() and registered at the app root, so the DRIZZLE
 * token is available to SizeChartRepository without an explicit import here —
 * mirroring the pattern used by OrdersModule and ProductsModule.
 *
 * Only SizingService is exported: it is the sanctioned entry point for other
 * modules (e.g. the Mastra agent tool) that need size recommendations.
 * SizeChartRepository stays internal.
 */
@Module({
  providers: [SizeChartRepository, SizingService],
  exports: [SizingService],
})
export class SizingModule {}
