/**
 * find_similar_by_image — visual catalog search.
 *
 * The customer sends a photo (optionally with a caption); ProductsService embeds
 * it with gemini-embedding-2 (image + caption) and returns the visually closest
 * PUBLISHED products via pgvector cosine ANN
 * search. Results are shaped identically to `search_products` so the agent
 * renders them the same way.
 *
 * Never invents products: if no image url is provided, nothing clears the
 * similarity threshold, or the pipeline errors, it returns an empty list and the
 * agent falls back gracefully (ask for a photo / offer text search).
 */

import { createTool } from '@mastra/core/tools';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import type { ProductsService } from '@/modules/products/products.service';

const logger = new Logger('FindSimilarByImageTool');

// The image URL is injected into the request context by AgentService (from
// input.lastImageUrl) before the generate() call — the agent NEVER provides
// it as a tool argument.
// `target_color` is optional: the agent provides it when the customer asks for
// the same design in a specific color. Normalization (color_synonyms) happens
// in ProductsService, not here.
const inputSchema = z.object({
  target_color: z
    .string()
    .optional()
    .describe('Specific color she wants for this design (e.g. "أسود"), if any'),
});

// Lean model-facing payload (see search-products.tool.ts): id/name/price/
// colors/available only — these results re-enter the prompt on every step.
const outputSchema = z.object({
  products: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      // price is a string (JOD numeric) — money is a string end-to-end; never float.
      price: z.string(),
      // Full set of canonical colour names across the product's image variants.
      colors: z.array(z.string()),
      available: z.boolean(),
    }),
  ),
});

export function buildFindSimilarByImageTool(products: ProductsService) {
  return createTool({
    id: 'find_similar_by_image',
    description:
      'Visually search the catalog for the photo the customer just sent (URL is taken from context — call with no arguments). On empty results ask for a clearer photo or fall back to text search; never invent products.',
    inputSchema,
    outputSchema,

    execute: async (input, ctx) => {
      // Read the image URL from the request context (set by AgentService from
      // input.lastImageUrl before the generate() call — never from model input).
      const url = (
        ctx?.requestContext?.get('lastImageUrl') as string | undefined
      )?.trim();
      if (!url) {
        // No image in context this turn — empty result; the agent asks for a photo.
        return { products: [] };
      }
      // The customer's caption this turn (set by AgentService) is embedded
      // TOGETHER with her photo, so search matches on both picture and words.
      const rawText = ctx?.requestContext?.get('lastImageText');
      const text = typeof rawText === 'string' ? rawText.trim() : undefined;
      try {
        const matches = await products.findSimilarByImage(url, {
          targetColor: input.target_color,
          text,
        });
        const colorsByProduct = await products.getColorNamesByProducts(
          matches.map((p) => p.id),
        );
        return {
          products: matches.map((p) => ({
            id: p.id,
            name: p.name,
            price: p.priceJod,
            colors: colorsByProduct.get(p.id) ?? [],
            available: p.stockStatus !== 'out',
          })),
        };
      } catch (err) {
        // Visual search is best-effort; never throw into the agent's turn.
        logger.warn(
          `find_similar_by_image failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { products: [] };
      }
    },
  });
}
