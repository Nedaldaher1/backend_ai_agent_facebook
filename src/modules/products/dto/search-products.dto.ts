import { z } from 'zod';

/**
 * Query schema for GET /products. Validated by ZodValidationPipe at the route.
 * `color` is the customer's (possibly dialect) term; the service normalizes it
 * to a color family via color_synonyms.
 */
export const searchProductsSchema = z
  .object({
    color: z.string().min(1).optional(),
    colorFamily: z.string().min(1).optional(),
    size: z.string().min(1).optional(),
    fabric: z.string().min(1).optional(),
    occasion: z.string().min(1).optional(),
  })
  .strict();

export type SearchProductsDto = z.infer<typeof searchProductsSchema>;
