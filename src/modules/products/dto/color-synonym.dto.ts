import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  createColorSynonymSchema,
  updateColorSynonymSchema,
} from '@/common/validation';
import { selectColorSynonymSchema } from '../entities/color-synonym.entity';

/**
 * OpenAPI DTOs for the admin color-synonyms surface. Validation stays with the
 * zod schemas in `@/common/validation`; these classes only document
 * request/response shapes in the Scalar docs.
 *
 * The response shape re-types the single timestamp column from `z.date()` to an
 * ISO-8601 string (see knowledge.dto.ts for the rationale).
 */
export const colorSynonymResponseSchema = selectColorSynonymSchema.extend({
  createdAt: z.iso.datetime(),
});

export class ColorSynonymDto extends createZodDto(colorSynonymResponseSchema) {}
export class CreateColorSynonymDto extends createZodDto(
  createColorSynonymSchema,
) {}
export class UpdateColorSynonymDto extends createZodDto(
  updateColorSynonymSchema,
) {}
