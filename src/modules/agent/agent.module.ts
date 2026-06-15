import { Module } from '@nestjs/common';
import { ConversationsModule } from '@/modules/conversations/conversations.module';
import { KnowledgeModule } from '@/modules/knowledge/knowledge.module';
import { OrdersModule } from '@/modules/orders/orders.module';
import { ProductsModule } from '@/modules/products/products.module';
import { AgentService } from './agent.service';

/**
 * Importing a module gives access to its *exported services* only. That is the
 * single allowed channel between domains — if you ever need forwardRef() here,
 * the boundary is wrong, not the wiring.
 */
@Module({
  imports: [ProductsModule, ConversationsModule, OrdersModule, KnowledgeModule],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
