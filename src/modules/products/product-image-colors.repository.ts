import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { colors } from './entities/color.entity';
import { productImageColors } from './entities/product-image-color.entity';
import { products } from './entities/product.entity';

/** Usage of one color across product images (counts + the products using it). */
export interface ColorUsageRow {
  productCount: number;
  imageCount: number;
  products: Array<{ id: string; name: string }>;
}

/** One color attached to one image, flattened with the storage key it belongs to. */
export interface ImageColorRow {
  storageKey: string;
  id: string;
  name: string;
  family: string;
  hex: string | null;
}

/**
 * Sole owner of product_image_colors SQL. Reads join onto `colors` so callers
 * get color details, not bare ids. Writes go through `replaceForImage`, which
 * swaps an image's whole color set atomically. Query-builder only.
 */
@Injectable()
export class ProductImageColorsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Every (storage key -> color) tag for a product, joined to color details. */
  async findColorsByProduct(productId: string): Promise<ImageColorRow[]> {
    return this.db
      .select({
        storageKey: productImageColors.storageKey,
        id: colors.id,
        name: colors.name,
        family: colors.family,
        hex: colors.hex,
      })
      .from(productImageColors)
      .innerJoin(colors, eq(colors.id, productImageColors.colorId))
      .where(eq(productImageColors.productId, productId))
      .orderBy(asc(colors.name));
  }

  /**
   * Batched variant of findColorsByProduct for a SET of products — one query for
   * the whole search result page (avoids N+1). Returns flat rows; callers group
   * by productId. Empty array for empty input.
   */
  async findColorsByProducts(
    productIds: string[],
  ): Promise<Array<{ productId: string; name: string; family: string }>> {
    if (productIds.length === 0) return [];
    return this.db
      .select({
        productId: productImageColors.productId,
        name: colors.name,
        family: colors.family,
      })
      .from(productImageColors)
      .innerJoin(colors, eq(colors.id, productImageColors.colorId))
      .where(inArray(productImageColors.productId, productIds))
      .orderBy(asc(colors.name));
  }

  /**
   * Colors attached to ONE specific image (productId + storageKey), joined to
   * color details and ordered by name. Empty when the image has no color tag.
   * Used by order capture to snapshot the chosen image's color_name.
   */
  async findColorsByImage(
    productId: string,
    storageKey: string,
  ): Promise<ImageColorRow[]> {
    return this.db
      .select({
        storageKey: productImageColors.storageKey,
        id: colors.id,
        name: colors.name,
        family: colors.family,
        hex: colors.hex,
      })
      .from(productImageColors)
      .innerJoin(colors, eq(colors.id, productImageColors.colorId))
      .where(
        and(
          eq(productImageColors.productId, productId),
          eq(productImageColors.storageKey, storageKey),
        ),
      )
      .orderBy(asc(colors.name));
  }

  /**
   * Usage of one color: total image tags (`imageCount`), distinct products
   * (`productCount`), and the distinct products that use it (`products`, capped
   * at `productLimit`, ordered by name). Drives the pre-delete warning and the
   * sentinel "needs review" screen. Both queries filter on color_id, which the
   * composite PK (leading with product_id) can't serve, so they ride
   * product_image_colors_color_id_idx instead of seq-scanning.
   */
  async colorUsage(
    colorId: string,
    productLimit: number,
  ): Promise<ColorUsageRow> {
    const [counts] = await this.db
      .select({
        imageCount: sql<number>`count(*)::int`,
        productCount: sql<number>`count(distinct ${productImageColors.productId})::int`,
      })
      .from(productImageColors)
      .where(eq(productImageColors.colorId, colorId));

    const productRows = await this.db
      .selectDistinct({ id: products.id, name: products.name })
      .from(productImageColors)
      .innerJoin(products, eq(products.id, productImageColors.productId))
      .where(eq(productImageColors.colorId, colorId))
      .orderBy(asc(products.name))
      .limit(productLimit);

    return {
      productCount: counts?.productCount ?? 0,
      imageCount: counts?.imageCount ?? 0,
      products: productRows,
    };
  }

  /**
   * Replace the entire color set of one image in a single transaction: clear the
   * existing tags for (productId, storageKey), then insert the new set. `colorIds`
   * must be de-duplicated by the caller (the composite PK forbids duplicates).
   */
  async replaceForImage(
    productId: string,
    storageKey: string,
    colorIds: string[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(productImageColors)
        .where(
          and(
            eq(productImageColors.productId, productId),
            eq(productImageColors.storageKey, storageKey),
          ),
        );
      if (colorIds.length > 0) {
        await tx
          .insert(productImageColors)
          .values(
            colorIds.map((colorId) => ({ productId, storageKey, colorId })),
          );
      }
    });
  }

  /** Drop every color tag for one image (called when the image itself is removed). */
  async deleteForImage(productId: string, storageKey: string): Promise<void> {
    await this.db
      .delete(productImageColors)
      .where(
        and(
          eq(productImageColors.productId, productId),
          eq(productImageColors.storageKey, storageKey),
        ),
      );
  }
}
