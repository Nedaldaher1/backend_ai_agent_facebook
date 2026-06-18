import { Module } from '@nestjs/common';
import { SecurityModule } from '@/core/security/security.module';
import { ProductsModule } from '@/modules/products/products.module';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeRepository } from './knowledge.repository';
import { KnowledgeService } from './knowledge.service';

/**
 * Knowledge-base domain module.
 *
 * SecurityModule supplies JwtAuthGuard + RolesGuard for the admin routes.
 * ProductsModule exports ProductsService so KnowledgeService can verify that a
 * referenced product exists before inserting/updating product-specific entries.
 * No circular dependency: ProductsModule does not import KnowledgeModule.
 */
@Module({
  imports: [SecurityModule, ProductsModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, KnowledgeRepository],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
