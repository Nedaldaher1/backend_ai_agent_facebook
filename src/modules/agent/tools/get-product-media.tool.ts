/**
 * get_product_media — إرسال صور المنتج للزبونة حسب اللون.
 *
 * Thin adapter: validates input, calls ProductsService.getProductMediaByColors
 * (which owns ALL colour/synonym resolution and the publish gate), pushes the
 * SERVICE-selected image URLs into the per-turn `mediaSink` on the request
 * context — the Messenger controller drains it and delivers each as its own
 * image message — and returns a colour SUMMARY (no URLs) for the agent to reason
 * over. The agent must NEVER paste image URLs into its reply (stripImageMarkup is
 * the backstop).
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { ProductsService } from '@/modules/products/products.service';

const inputSchema = z.object({
  product_id: z.string().describe('معرّف المنتج (UUID) المراد إرسال صوره'),
  // Free-form string array (NOT an enum): colours are dynamic, managed in the
  // Colors page, and resolved server-side. Pass the customer's exact words
  // (including dialect); do NOT normalize, translate, or add colours she didn't
  // mention. Omit / empty → send every available colour.
  colors: z
    .array(z.string())
    .optional()
    .describe(
      'Colors the customer explicitly asked for, exactly as she said them (e.g. ["أسود","نبيتي"]). Omit to send all of the model\'s colors.',
    ),
});

const outputSchema = z.object({
  // Canonical colour names actually sent (e.g. ["أحمر"]).
  sent_colors: z.array(z.string()),
  // Requested colours this model doesn't offer — tell the customer plainly and
  // never silently substitute another colour.
  unavailable_colors: z.array(z.string()),
  // How many photos were dispatched this call.
  sent_image_count: z.number(),
  // False when the model id wasn't found / is unpublished — ask her to confirm it.
  product_found: z.boolean(),
});

export function buildGetProductMediaTool(products: ProductsService) {
  return createTool({
    id: 'get_product_media',
    description:
      "Send a model's photos to the customer (delivered automatically as separate image messages — NEVER paste image URLs in your reply). Pass `colors` ONLY with colors she named, exactly as she said them; omit it to send all colors. Read the result before replying: confirm sent_colors; if unavailable_colors is non-empty say so plainly and offer what IS available (never substitute silently); if product_found=false ask her to confirm the model.",
    inputSchema,
    outputSchema,

    execute: async (input, ctx) => {
      const result = await products.getProductMediaByColors(
        input.product_id,
        input.colors,
      );

      // Side-channel: hand the SERVICE-selected image URLs to the per-turn sink
      // AgentService placed on the request context. The Messenger controller
      // drains it into standalone image messages. The agent-facing output carries
      // no URLs — only the colour summary below.
      const sink = ctx?.requestContext?.get('mediaSink');
      if (Array.isArray(sink)) {
        for (const url of result.mediaUrls) sink.push(url);
      }

      return {
        sent_colors: result.sentColors,
        unavailable_colors: result.unavailableColors,
        sent_image_count: result.mediaUrls.length,
        product_found: result.productFound,
      };
    },
  });
}
