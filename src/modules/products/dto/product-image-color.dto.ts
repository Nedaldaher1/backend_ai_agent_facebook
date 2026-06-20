import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { setImageColorsSchema } from '@/common/validation';

/**
 * OpenAPI DTOs for tagging a product image with canonical colors. Validation
 * stays with `setImageColorsSchema` in `@/common/validation`; these classes only
 * document the request/response shapes in the Scalar docs.
 */
export class SetImageColorsDto extends createZodDto(setImageColorsSchema) {}

/** A canonical color as it appears attached to an image. */
export const imageColorSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  family: z.string(),
  hex: z.string().nullable(),
});

/** One image: its storage key, resolved public URL, primary flag, and colors. */
export const imageWithColorsSchema = z.object({
  key: z.string(),
  url: z.string(),
  isPrimary: z.boolean(),
  colors: z.array(imageColorSchema),
  // Whether the image is indexed for visual search (current embedding model).
  // Reported by GET .../images; omitted by the color-tagging response.
  hasEmbedding: z.boolean().optional(),
});

export class ImageWithColorsDto extends createZodDto(imageWithColorsSchema) {}
