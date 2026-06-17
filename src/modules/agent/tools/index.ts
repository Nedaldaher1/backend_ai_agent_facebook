/**
 * Sales tools barrel.
 *
 * `buildSalesTools(deps)` constructs all six Mastra tools by closing over the
 * injected domain services. Tools never import a repository or run SQL directly.
 *
 * The returned object is keyed by the tool id (snake_case) exactly as required
 * by the Agent constructor.
 */

import type { ProductsService } from '@/modules/products/products.service';
import type { OrdersService } from '@/modules/orders/orders.service';
import type { ConversationsService } from '@/modules/conversations/conversations.service';
import { buildSearchProductsTool } from './search-products.tool';
import { findSimilarByImageTool } from './find-similar-by-image.tool';
import { buildCheckAvailabilityTool } from './check-availability.tool';
import { buildGetProductMediaTool } from './get-product-media.tool';
import { buildCaptureOrderTool } from './capture-order.tool';
import { buildEscalateToHumanTool } from './escalate-to-human.tool';

/** Injected domain services required to build the sales tools. */
export interface SalesToolsDeps {
  products: ProductsService;
  orders: OrdersService;
  conversations: ConversationsService;
}

/**
 * Build all sales tools, closing over the provided services.
 * Call once at module-init time (from mastra.factory.ts).
 */
export function buildSalesTools(deps: SalesToolsDeps) {
  const { products, orders, conversations } = deps;

  return {
    search_products: buildSearchProductsTool(products),
    check_availability: buildCheckAvailabilityTool(products),
    get_product_media: buildGetProductMediaTool(products),
    capture_order: buildCaptureOrderTool(products, orders),
    escalate_to_human: buildEscalateToHumanTool(conversations),
    find_similar_by_image: findSimilarByImageTool,
  } as const;
}
