import { Module } from '@nestjs/common';
import { SecurityModule } from '@/core/security/security.module';
import { ConversationControlService } from '@/modules/conversations/conversation-control.service';
import { ConversationsAdminController } from '@/modules/conversations/conversations-admin.controller';
import { ConversationsModule } from '@/modules/conversations/conversations.module';
import { KnowledgeModule } from '@/modules/knowledge/knowledge.module';
import { OrdersModule } from '@/modules/orders/orders.module';
import { ProductsModule } from '@/modules/products/products.module';
import { SizingModule } from '@/modules/sizing/sizing.module';
import { AgentBehaviorRepository } from './agent-behavior.repository';
import { AgentBehaviorService } from './agent-behavior.service';
import { AgentService } from './agent.service';
import { DebounceService } from './debounce/debounce.service';
import { MessengerClient } from './messenger/messenger.client';
import { MessengerSignatureGuard } from './messenger/messenger-signature.guard';
import { MessengerWebhookController } from './messenger/messenger-webhook.controller';
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
 * The sole inbound transport is the Meta Messenger Platform (Graph API v25.0)
 * via MessengerWebhookController. MessengerClient is also provided here and
 * used by ConversationControlService for admin-initiated human-agent delivery.
 */
@Module({
  imports: [
    SecurityModule,
    ProductsModule,
    ConversationsModule,
    OrdersModule,
    KnowledgeModule,
    SizingModule,
  ],
  controllers: [
    MessengerWebhookController,
    ConversationsAdminController,
  ],
  providers: [
    AgentService,
    AgentBehaviorService,
    AgentBehaviorRepository,
    VisionService,
    DebounceService,
    MessengerClient,
    MessengerSignatureGuard,
    ConversationControlService,
  ],
  exports: [AgentService, AgentBehaviorService, MessengerClient],
})
export class AgentModule {}
