import { BadRequestException } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Parse `value` against a zod schema and return the typed, stripped result, or
 * throw a Nest `BadRequestException` (400) carrying the zod issues.
 *
 * This is the single write-validation entry point: the data-access services call
 * it before every insert/update, `ZodValidationPipe` calls it for HTTP payloads,
 * and the Mastra agent tools will call it (or reuse the same schemas) for tool
 * inputs — so every write path rejects invalid data the same way.
 */
export function parseOrThrow<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException({
      message: 'Validation failed',
      issues: result.error.issues,
    });
  }
  return result.data;
}
