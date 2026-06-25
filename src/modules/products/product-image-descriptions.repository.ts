import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { productImageDescriptions } from './entities/product-image-description.entity';

/**
 * Sole owner of product_image_descriptions SQL. One admin-authored description
 * per (productId, storageKey); the text is embedded TOGETHER with the image
 * (see EmbeddingService.embedImageWithText) so visual search uses both the
 * picture and the words. Query-builder only.
 */
@Injectable()
export class ProductImageDescriptionsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Every (storage key -> description) for a product, as a lookup map. */
  async getMapByProduct(productId: string): Promise<Record<string, string>> {
    const rows = await this.db
      .select({
        storageKey: productImageDescriptions.storageKey,
        description: productImageDescriptions.description,
      })
      .from(productImageDescriptions)
      .where(eq(productImageDescriptions.productId, productId));
    return Object.fromEntries(rows.map((r) => [r.storageKey, r.description]));
  }

  /** Insert or replace the description of one image (idempotent upsert on PK). */
  async upsert(
    productId: string,
    storageKey: string,
    description: string,
  ): Promise<void> {
    await this.db
      .insert(productImageDescriptions)
      .values({ productId, storageKey, description })
      .onConflictDoUpdate({
        target: [
          productImageDescriptions.productId,
          productImageDescriptions.storageKey,
        ],
        set: { description },
      });
  }

  /** Drop the description for one image (called when the image is removed). */
  async deleteForImage(productId: string, storageKey: string): Promise<void> {
    await this.db
      .delete(productImageDescriptions)
      .where(
        and(
          eq(productImageDescriptions.productId, productId),
          eq(productImageDescriptions.storageKey, storageKey),
        ),
      );
  }
}
