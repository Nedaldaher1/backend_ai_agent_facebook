/**
 * Sales tools barrel.
 *
 * `buildSalesTools(deps)` constructs all eight Mastra tools by closing over the
 * injected domain services. Tools never import a repository or run SQL directly.
 *
 * The returned object is keyed by the tool id (snake_case) exactly as required
 * by the Agent constructor.
 *
 * Key order (grouped by read vs. write):
 *   search_products, check_availability, get_product_media, get_knowledge,
 *   recommend_size, capture_order, escalate_to_human, find_similar_by_image
 */

import type { ProductsService } from '@/modules/products/products.service';
import type { OrdersService } from '@/modules/orders/orders.service';
import type { ConversationsService } from '@/modules/conversations/conversations.service';
import type { KnowledgeService } from '@/modules/knowledge/knowledge.service';
import type { SizingService } from '@/modules/sizing/sizing.service';
import { buildSearchProductsTool } from './search-products.tool';
import { buildFindSimilarByImageTool } from './find-similar-by-image.tool';
import { buildCheckAvailabilityTool } from './check-availability.tool';
import { buildGetProductMediaTool } from './get-product-media.tool';
import { buildGetKnowledgeTool } from './get-knowledge.tool';
import { buildRecommendSizeTool } from './recommend-size.tool';
import { buildCaptureOrderTool } from './capture-order.tool';
import { buildEscalateToHumanTool } from './escalate-to-human.tool';

/** Injected domain services required to build the sales tools. */
export interface SalesToolsDeps {
  products: ProductsService;
  orders: OrdersService;
  conversations: ConversationsService;
  knowledge: KnowledgeService;
  sizing: SizingService;
}

/**
 * Build all sales tools, closing over the provided services.
 * Call once at module-init time (from mastra.factory.ts).
 */
export function buildSalesTools(deps: SalesToolsDeps) {
  const { products, orders, conversations, knowledge, sizing } = deps;

  return {
    search_products: buildSearchProductsTool(products),
    check_availability: buildCheckAvailabilityTool(products),
    get_product_media: buildGetProductMediaTool(products),
    get_knowledge: buildGetKnowledgeTool(knowledge),
    recommend_size: buildRecommendSizeTool(sizing),
    capture_order: buildCaptureOrderTool(orders),
    escalate_to_human: buildEscalateToHumanTool(conversations),
    find_similar_by_image: buildFindSimilarByImageTool(products),
  } as const;
}
