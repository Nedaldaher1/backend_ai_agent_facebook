import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  createKnowledgeEntrySchema,
  updateKnowledgeEntrySchema,
} from '@/common/validation';
import { selectKnowledgeEntrySchema } from '../entities/knowledge-entry.entity';

/**
 * OpenAPI DTOs for knowledge entries. Validation stays with the shared
 * create/update schemas in `@/common/validation`; these classes only document
 * the request/response shapes in the Scalar docs (and feed the frontend's
 * generated `api.d.ts` types).
 *
 * The response schema re-types the drizzle-zod `z.date()` timestamps as
 * ISO-8601 strings, same as `ProductDto` — `Date` is not representable in JSON
 * Schema, and over the wire the columns serialize to ISO strings anyway.
 */
export const knowledgeEntryResponseSchema = selectKnowledgeEntrySchema.extend({
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
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
