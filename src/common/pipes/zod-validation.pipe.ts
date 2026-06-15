import { BadRequestException, PipeTransform } from '@nestjs/common';
import { z } from 'zod';

/**
 * Validates/parses an incoming payload against a zod schema and returns the
 * typed, stripped result. Apply per-route: `@Query(new ZodValidationPipe(schema))`.
 *
 * This is the project's primary validation path (zod is also what Mastra tools
 * use); class-validator stays available via the global ValidationPipe in main.ts.
 */
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        issues: result.error.issues,
      });
    }
    return result.data;
  }
}
