import { Injectable } from '@nestjs/common';
import {
  ProductsService,
  type ProductSearchInput,
} from '@/modules/products/products.service';

/**
 * The Mastra agent runtime. It composes the other domains strictly through
 * their exported services (never their repositories or the database directly),
 * which keeps every module boundary clean. Only ProductsService is injected
 * today; ConversationsService / OrdersService / KnowledgeService are added here
 * as each domain is implemented (their modules are already imported in
 * agent.module.ts).
 *
 * TODO (mastra-agent-engineer):
 *  - build the Claude agent (@ai-sdk/anthropic) and register tools from ./tools,
 *    each tool delegating to a domain service like searchProducts() below;
 *  - wire conversation memory from ./memory (@mastra/memory + @mastra/pg);
 *  - wire the customer-image attribute extraction from ./vision.
 */
@Injectable()
export class AgentService {
  constructor(private readonly products: ProductsService) {}

  /**
   * Example of the only sanctioned cross-domain call style: through the
   * exported service. The real agent will expose this via a Mastra tool.
   */
  searchProducts(input: ProductSearchInput) {
    return this.products.search(input);
  }

  reply(): Promise<string> {
    // Placeholder until the Mastra agent is wired.
    return Promise.reject(
      new Error('AgentService.reply is not implemented yet'),
    );
  }
}
