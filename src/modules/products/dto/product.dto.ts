import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  createProductSchema,
  updateProductSchema,
} from '@/common/validation';
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

/** Page of products returned by `GET /admin/products`. */
export const paginatedProductsSchema = z.object({
  items: z.array(productResponseSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

/**
 * Request DTOs for the admin write surface. Validation stays with the zod
 * schemas in `@/common/validation`; these only document the request bodies in
 * the Scalar docs. The create/update schemas omit the server-managed `id` and
 * timestamp columns, so they carry no `Date`-typed field and serialize cleanly.
 */
export class CreateProductDto extends createZodDto(createProductSchema) {}
export class UpdateProductDto extends createZodDto(updateProductSchema) {}
export class PaginatedProductsDto extends createZodDto(
  paginatedProductsSchema,
) {}
