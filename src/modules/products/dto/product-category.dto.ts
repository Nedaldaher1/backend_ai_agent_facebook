import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  createProductCategorySchema,
  updateProductCategorySchema,
} from '@/common/validation';
import { selectProductCategorySchema } from '../entities/product-category.entity';

/**
 * OpenAPI DTOs for the admin product-categories surface. Validation stays with
 * the zod schemas in `@/common/validation`; these classes only document
 * request/response shapes in the Scalar docs (and feed the frontend's generated
 * `api.d.ts`). The response re-types the timestamp columns from `z.date()` to
 * ISO-8601 strings (see color.dto.ts for the rationale).
 */
export const productCategoryResponseSchema = selectProductCategorySchema.extend(
  {
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  },
);

export class ProductCategoryDto extends createZodDto(
  productCategoryResponseSchema,
) {}
export class CreateProductCategoryDto extends createZodDto(
  createProductCategorySchema,
) {}
export class UpdateProductCategoryDto extends createZodDto(
  updateProductCategorySchema,
) {}

/** Result of deleting a category. */
export const deleteProductCategoryResultSchema = z.object({
  deleted: z.literal(true),
});
export type DeleteProductCategoryResult = z.infer<
  typeof deleteProductCategoryResultSchema
>;
export class DeleteProductCategoryResultDto extends createZodDto(
  deleteProductCategoryResultSchema,
) {}
