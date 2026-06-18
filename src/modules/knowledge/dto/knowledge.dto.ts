import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  createKnowledgeEntrySchema,
  updateKnowledgeEntrySchema,
} from '@/common/validation';
import { selectKnowledgeEntrySchema } from '../entities/knowledge-entry.entity';

/**
 * OpenAPI DTOs for the admin knowledge surface. Validation stays with the zod
 * schemas in `@/common/validation`; these classes only document request/response
 * shapes in the Scalar docs (mirrors the auth/products DTO pattern).
 *
 * The response shape re-types the two timestamp columns: drizzle-zod models them
 * as `z.date()` (JS `Date`), which `z.toJSONSchema` cannot represent. Over the
 * wire they serialize to ISO-8601 strings, so we document them as such. The DTO
 * is never used as an input, so it never reaches a validation pipe.
 */
export const knowledgeEntryResponseSchema = selectKnowledgeEntrySchema.extend({
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** Page of knowledge entries returned by `GET /admin/knowledge`. */
export const paginatedKnowledgeSchema = z.object({
  items: z.array(knowledgeEntryResponseSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

export class KnowledgeEntryDto extends createZodDto(
  knowledgeEntryResponseSchema,
) {}
export class CreateKnowledgeEntryDto extends createZodDto(
  createKnowledgeEntrySchema,
) {}
export class UpdateKnowledgeEntryDto extends createZodDto(
  updateKnowledgeEntrySchema,
) {}
export class PaginatedKnowledgeDto extends createZodDto(
  paginatedKnowledgeSchema,
) {}
