import { Module } from '@nestjs/common';
import { SecurityModule } from '@/core/security/security.module';
import { ProductsModule } from '@/modules/products/products.module';
import { OrdersController } from './orders.controller';
import { OrdersAdminController } from './orders-admin.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';

/**
 * Imports ProductsModule so the COD capture flow can read the catalog
 * (price/availability/colors) through the exported ProductsService — the only
 * sanctioned cross-domain channel. ProductsModule does not import OrdersModule,
 * so there is no cycle.
 *
 * SecurityModule supplies JwtAuthGuard + RolesGuard (and the JwtModule they need)
 * for the guarded /admin/orders routes, so the JWT wiring is not duplicated here.
 */
@Module({
  imports: [SecurityModule, ProductsModule],
  controllers: [OrdersController, OrdersAdminController],
  providers: [OrdersService, OrdersRepository],
  exports: [OrdersService],
})
export class OrdersModule {}
