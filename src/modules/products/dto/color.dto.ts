import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { createColorSchema, updateColorSchema } from '@/common/validation';
import { selectColorSchema } from '../entities/color.entity';

/**
 * OpenAPI DTOs for the admin colors surface. Validation stays with the zod
 * schemas in `@/common/validation`; these classes only document request/response
 * shapes in the Scalar docs. The response re-types the timestamp columns from
 * `z.date()` to ISO-8601 strings (see knowledge.dto.ts for the rationale).
 */
export const colorResponseSchema = selectColorSchema.extend({
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export class ColorDto extends createZodDto(colorResponseSchema) {}
export class CreateColorDto extends createZodDto(createColorSchema) {}
export class UpdateColorDto extends createZodDto(updateColorSchema) {}

/** One product that uses a color, for the usage report. */
const colorUsageProductSchema = z.object({
  id: z.uuid(),
  name: z.string(),
});

/**
 * Usage report for a color: how many image tags (`imageCount`) and distinct
 * products (`productCount`) reference it, plus the distinct products that use it
 * (`products`, capped) and whether more exist beyond the cap (`hasMore`). Powers
 * the pre-delete warning and the sentinel "needs review" queue.
 */
export const colorUsageSchema = z.object({
  productCount: z.number().int(),
  imageCount: z.number().int(),
  products: z.array(colorUsageProductSchema),
  hasMore: z.boolean(),
});
export type ColorUsage = z.infer<typeof colorUsageSchema>;
export class ColorUsageDto extends createZodDto(colorUsageSchema) {}

/**
 * Result of a safe color delete: inside one transaction the color's image tags
 * were reassigned to the "غير معرف" sentinel and the color row removed. Counts
 * are for the admin UI confirmation.
 */
export const deleteColorResultSchema = z.object({
  deleted: z.literal(true),
  reassignedImages: z.number().int(),
  affectedProducts: z.number().int(),
});
export type DeleteColorResult = z.infer<typeof deleteColorResultSchema>;
export class DeleteColorResultDto extends createZodDto(
  deleteColorResultSchema,
) {}
