import { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { parseOrThrow } from '@/common/validation/parse';

/**
 * Validates/parses an incoming payload against a zod schema and returns the
 * typed, stripped result. Apply per-route: `@Query(new ZodValidationPipe(schema))`.
 *
 * This is the project's primary validation path (zod is also what Mastra tools
 * use); class-validator stays available via the global ValidationPipe in main.ts.
 * Delegates to `parseOrThrow` so HTTP routes and the data-access services reject
 * invalid input identically.
 */
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    return parseOrThrow(this.schema, value);
  }
}
