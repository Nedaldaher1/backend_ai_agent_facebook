import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { selectProductSchema } from '../entities/product.entity';

/**
 * OpenAPI/response shape of a product, used only to document responses
 * (`@ApiOkResponse`). It is derived from the canonical drizzle-zod
 * `selectProductSchema` so there is no second schema to maintain — the only
 * change is re-typing the two timestamp columns.
 *
 * Drizzle/`drizzle-zod` model `timestamp` columns as `z.date()` (JS `Date`),
 * but `Date` is not representable in JSON Schema (and `z.toJSONSchema` throws on
 * it). Over the wire these serialize to ISO-8601 strings, so we document them as
 * such. This DTO is never used as an input, so it never reaches a validation pipe.
 */
export const productResponseSchema = selectProductSchema.extend({
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export class ProductDto extends createZodDto(productResponseSchema) {}
