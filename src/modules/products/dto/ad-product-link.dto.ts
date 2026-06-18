import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  createAdProductLinkSchema,
  updateAdProductLinkSchema,
} from '@/common/validation';
import { selectAdProductLinkSchema } from '../entities/ad-product-link.entity';

/**
 * OpenAPI DTOs for the admin ad-product-links surface. Validation stays with the
 * zod schemas in `@/common/validation`; these classes only document
 * request/response shapes in the Scalar docs.
 *
 * The response shape re-types the timestamp columns from `z.date()` to ISO-8601
 * strings (see knowledge.dto.ts for the rationale).
 */
export const adProductLinkResponseSchema = selectAdProductLinkSchema.extend({
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export class AdProductLinkDto extends createZodDto(
  adProductLinkResponseSchema,
) {}
export class CreateAdProductLinkDto extends createZodDto(
  createAdProductLinkSchema,
) {}
export class UpdateAdProductLinkDto extends createZodDto(
  updateAdProductLinkSchema,
) {}
