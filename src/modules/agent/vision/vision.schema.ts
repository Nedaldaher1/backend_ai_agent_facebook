/**
 * The structured schema Claude must populate when describing a customer image.
 *
 * "Strict closed enum" (per the workflow design) is only literally achievable
 * for attributes backed by a lookup table: COLOR (colors.family). It becomes a
 * closed zod enum sourced from the DB at runtime. Sizes are now per-product and
 * admin-defined, so there is no global size vocabulary to extract against.
 * occasion/fabric/sleeve/embellishment are FREE TEXT in the catalog, so they
 * stay free strings guided by prompt vocabulary, validated downstream by the
 * search path (which already treats them as free-text filters).
 */

import { z } from 'zod';

/**
 * Catalog-sourced vocabularies. Colors drive a CLOSED enum; occasions/fabrics
 * are soft (prompt guidance only).
 */
export interface VisionEnums {
  colorFamilies: string[];
  occasions: string[];
  fabrics: string[];
}

export const EMPTY_VISION_ENUMS: VisionEnums = {
  colorFamilies: [],
  occasions: [],
  fabrics: [],
};

/**
 * Build the extraction schema. Color is a CLOSED enum when the catalog supplies
 * values (guaranteeing the model returns a value search understands); it widens
 * to a free string only when the catalog is empty, so extraction never
 * hard-fails on a fresh DB.
 */
export function buildVisionAttributeSchema(enums: VisionEnums) {
  const colorField = enums.colorFamilies.length
    ? z.enum(enums.colorFamilies as [string, ...string[]]).nullable()
    : z.string().nullable();

  return z.object({
    isClothing: z
      .boolean()
      .describe(
        'هل الصورة فعلاً لقطعة ملابس من نوع المتجر (عباية، بجامة، فستان، ...)؟ false لأي صورة أخرى',
      ),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe('ثقتك بصحة السمات المستخرجة، من 0 إلى 1'),
    color: colorField.describe(
      'عائلة اللون الأقرب من القائمة المعطاة، أو null إذا غير واضح',
    ),
    occasion: z
      .string()
      .nullable()
      .optional()
      .describe('المناسبة (مثل: سهرة، يومي، عمل) إن وُضحت'),
    fabric: z.string().nullable().optional().describe('نوع القماش إن وُضح'),
    sleeveType: z.string().nullable().optional().describe('نوع الكُمّ إن وُضح'),
    embellishment: z
      .string()
      .nullable()
      .optional()
      .describe('الزخرفة أو التطريز إن وُجد'),
  });
}

/** The validated attributes the model returns (color normalized separately). */
export type VisionAttributes = z.infer<
  ReturnType<typeof buildVisionAttributeSchema>
>;
