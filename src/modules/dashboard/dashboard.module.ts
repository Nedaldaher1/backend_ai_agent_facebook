import { Module } from '@nestjs/common';
import { SecurityModule } from '@/core/security/security.module';
import { ConversationsModule } from '@/modules/conversations/conversations.module';
import { OrdersModule } from '@/modules/orders/orders.module';
import { ProductsModule } from '@/modules/products/products.module';
import { DashboardAdminController } from './dashboard-admin.controller';
import { DashboardService } from './dashboard.service';

/**
 * Admin-overview aggregates. Imports the domain modules and reads ONLY their
 * exported services (the single sanctioned cross-domain channel); owns no
 * tables of its own, so there is no repository here.
 */
@Module({
  imports: [SecurityModule, ProductsModule, OrdersModule, ConversationsModule],
  controllers: [DashboardAdminController],
  providers: [DashboardService],
})
export class DashboardModule {}
