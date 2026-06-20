import { Module } from '@nestjs/common';
import { SecurityModule } from '@/core/security/security.module';
import { AdProductLinksAdminController } from './ad-product-links-admin.controller';
import { AdProductLinksRepository } from './ad-product-links.repository';
import { AdProductLinksService } from './ad-product-links.service';
import { ColorSynonymsAdminController } from './color-synonyms-admin.controller';
import { ColorSynonymsRepository } from './color-synonyms.repository';
import { ColorSynonymsService } from './color-synonyms.service';
import { ColorsAdminController } from './colors-admin.controller';
import { ColorsRepository } from './colors.repository';
import { ColorsService } from './colors.service';
import { ProductImageColorsRepository } from './product-image-colors.repository';
import { ProductImagesAdminController } from './product-images-admin.controller';
import { ProductImagesController } from './product-images.controller';
import { ProductsAdminController } from './products-admin.controller';
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
 *
 * SecurityModule supplies JwtAuthGuard + RolesGuard (and the JwtModule they need)
 * for the guarded /admin/* routes, so the JWT wiring is not duplicated here.
 */
@Module({
  imports: [SecurityModule],
  controllers: [
    ProductsController,
    ProductImagesController,
    ProductsAdminController,
    ProductImagesAdminController,
    AdProductLinksAdminController,
    ColorSynonymsAdminController,
    ColorsAdminController,
  ],
  providers: [
    ProductsService,
    ProductsRepository,
    ColorSynonymsService,
    ColorSynonymsRepository,
    ColorsService,
    ColorsRepository,
    ProductImageColorsRepository,
    AdProductLinksRepository,
    AdProductLinksService,
  ],
  exports: [ProductsService, ColorSynonymsService, ColorsService],
})
export class ProductsModule {}
