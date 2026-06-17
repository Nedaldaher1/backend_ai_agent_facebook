import { Module } from '@nestjs/common';
import { ColorSynonymsRepository } from './color-synonyms.repository';
import { ColorSynonymsService } from './color-synonyms.service';
import { ProductImagesController } from './product-images.controller';
import { ProductsController } from './products.controller';
import { ProductsRepository } from './products.repository';
import { ProductsService } from './products.service';

/**
 * Reference module. Other domains mirror this layout:
 *   controller (HTTP) -> service (logic) -> repository (SQL) -> database.
 * Both services are exported, so cross-module access goes through them.
 * color_synonyms lives here because product search depends on it for color
 * normalization. Image uploads (ProductImagesController) reach storage through
 * the global StorageModule, so no extra import is needed here.
 */
@Module({
  controllers: [ProductsController, ProductImagesController],
  providers: [
    ProductsService,
    ProductsRepository,
    ColorSynonymsService,
    ColorSynonymsRepository,
  ],
  exports: [ProductsService, ColorSynonymsService],
})
export class ProductsModule {}
