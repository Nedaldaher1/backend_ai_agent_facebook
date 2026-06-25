import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { setImageDescriptionSchema } from '@/common/validation';

/**
 * OpenAPI DTOs for an image's admin-authored description. Validation stays with
 * `setImageDescriptionSchema` in `@/common/validation`; these classes only
 * document the request/response shapes in the Scalar docs.
 */
export class SetImageDescriptionDto extends createZodDto(
  setImageDescriptionSchema,
) {}

/** One image: storage key, resolved public URL, primary flag, and description. */
export const imageWithDescriptionSchema = z.object({
  key: z.string(),
  url: z.string(),
  isPrimary: z.boolean(),
  description: z.string(),
});

export class ImageWithDescriptionDto extends createZodDto(
  imageWithDescriptionSchema,
) {}
