/**
 * find_similar_by_image — STUB (Phase 2 placeholder).
 *
 * Visual similarity search is not yet implemented. The full implementation will
 * use pgvector + a CLIP or similar embedding model to find catalog products whose
 * image embedding is closest to the customer's image.
 *
 * TODO (Phase 2: pgvector/CLIP): replace stub with real embedding pipeline.
 *
 * No service dependencies — this tool returns a static response.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const inputSchema = z.object({
  image_url: z
    .string()
    .optional()
    .describe('رابط صورة العباءة التي أرسلتها الزبونة للبحث عن منتجات مشابهة'),
});

const outputSchema = z.object({
  products: z.array(z.any()).default([]),
  note: z.string(),
});

export const findSimilarByImageTool = createTool({
  id: 'find_similar_by_image',
  description:
    'ابحثي عن عبايات مشابهة لصورة أرسلتها الزبونة (غير متاح حالياً).',
  inputSchema,
  outputSchema,

  execute: async (_input) => {
    // TODO (Phase 2: pgvector/CLIP): embed the image and run a cosine-similarity
    // search against the product embeddings table.
    return {
      products: [],
      note: 'visual search not available yet',
    };
  },
});
