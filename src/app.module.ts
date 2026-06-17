import { Module } from '@nestjs/common';
import { AppConfigModule } from '@/core/config/config.module';
import { DatabaseModule } from '@/core/database/database.module';
import { HealthModule } from '@/core/health/health.module';
import { StorageModule } from '@/core/storage/storage.module';
import { AdminModule } from '@/modules/admin/admin.module';
import { AuthModule } from '@/modules/auth/auth.module';
import { AgentModule } from '@/modules/agent/agent.module';
import { ConversationsModule } from '@/modules/conversations/conversations.module';
import { KnowledgeModule } from '@/modules/knowledge/knowledge.module';
import { OrdersModule } from '@/modules/orders/orders.module';
import { ProductsModule } from '@/modules/products/products.module';

/**
 * Composition root: wires core + feature modules only. No controllers,
 * providers, or business logic live here.
 */
@Module({
  imports: [
    // core
    AppConfigModule,
    DatabaseModule,
    StorageModule,
    HealthModule,
    // domains
    AdminModule,
    AuthModule,
    ProductsModule,
    ConversationsModule,
    OrdersModule,
    KnowledgeModule,
    // agent (depends on the domains above, via their services)
    AgentModule,
  ],
})
export class AppModule {}
