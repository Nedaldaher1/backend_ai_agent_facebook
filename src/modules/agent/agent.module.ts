import { Module } from '@nestjs/common';
import { ConversationsModule } from '@/modules/conversations/conversations.module';
import { KnowledgeModule } from '@/modules/knowledge/knowledge.module';
import { OrdersModule } from '@/modules/orders/orders.module';
import { ProductsModule } from '@/modules/products/products.module';
import { SizingModule } from '@/modules/sizing/sizing.module';
import { AgentBehaviorRepository } from './agent-behavior.repository';
import { AgentBehaviorService } from './agent-behavior.service';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { VisionService } from './vision/vision.service';

/**
 * Importing a module gives access to its *exported services* only. That is the
 * single allowed channel between domains — if you ever need forwardRef() here,
 * the boundary is wrong, not the wiring.
 *
 * agent_behavior is owned here (the agent's own persona config), so its
 * repository/service are local providers; AgentBehaviorService is exported for
 * the admin UI to manage personas.
 *
 * AgentController is a TEMPORARY smoke-test surface (POST /agent/ping) that
 * will be replaced by the ManyChat webhook controller in a later ticket.
 */
@Module({
  imports: [ProductsModule, ConversationsModule, OrdersModule, KnowledgeModule, SizingModule],
  controllers: [AgentController],
  providers: [
    AgentService,
    AgentBehaviorService,
    AgentBehaviorRepository,
    VisionService,
  ],
  exports: [AgentService, AgentBehaviorService],
})
export class AgentModule {}
