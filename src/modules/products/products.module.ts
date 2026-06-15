import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsRepository } from './products.repository';
import { ProductsService } from './products.service';

/**
 * Reference module. Other domains should mirror this layout:
 *   controller (HTTP) -> service (logic) -> repository (SQL) -> database.
 * Only the service is exported, so cross-module access goes through it.
 */
@Module({
  controllers: [ProductsController],
  providers: [ProductsService, ProductsRepository],
  exports: [ProductsService],
})
export class ProductsModule {}
