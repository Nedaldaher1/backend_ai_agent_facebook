import { Module } from '@nestjs/common';
import { SizingService } from './sizing.service';

/**
 * Sizing domain module.
 *
 * SizingService is now pure per-product logic (no DB): it takes a product's own
 * `sizes` list and picks the matching size for a customer's weight. The retired
 * brand-wide `size_chart` table (and its repository) are gone. Only
 * SizingService is exported — the sanctioned entry point for the Mastra agent
 * tool that needs size recommendations.
 */
@Module({
  providers: [SizingService],
  exports: [SizingService],
})
export class SizingModule {}
