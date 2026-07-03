import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, exists, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { normalizeListOptions, type ListOptions } from '@/common/types/query';
import { colors, type Color, type NewColor } from './entities/color.entity';
import { productImageColors } from './entities/product-image-color.entity';

/**
 * Sole owner of `colors` SQL. The canonical-color CRUD used by the admin surface
 * lives here; the dialect-term -> family resolution stays in
 * ColorSynonymsRepository (which joins onto this table). Query-builder only; no
 * business logic.
 */
@Injectable()
export class ColorsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * The assignable-color list (used by the admin to tag images). System colors
   * (e.g. the "__unassigned__" sentinel) are excluded — they are reserved and
   * must never be offered as a tagging choice. The sentinel stays reachable for
   * display via findById/findByFamily.
   */
  async list(opts: ListOptions = {}): Promise<Color[]> {
    const { limit, offset, orderBy } = normalizeListOptions(opts);
    const direction = orderBy === 'asc' ? asc : desc;
    return this.db
      .select()
      .from(colors)
      .where(eq(colors.isSystem, false))
      .orderBy(direction(colors.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async findById(id: string): Promise<Color | undefined> {
    const [row] = await this.db
      .select()
      .from(colors)
      .where(eq(colors.id, id))
      .limit(1);
    return row;
  }

  async findByFamily(family: string): Promise<Color | undefined> {
    const [row] = await this.db
      .select()
      .from(colors)
      .where(eq(colors.family, family))
      .limit(1);
    return row;
  }

  /**
   * Distinct canonical color families offered to customers (the system sentinel
   * is excluded, mirroring `list`). Source for the closed-enum color vocabulary
   * the vision pipeline uses; `family` is unique per row, selectDistinct guards.
   */
  async distinctFamilies(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ family: colors.family })
      .from(colors)
      .where(eq(colors.isSystem, false))
      .orderBy(asc(colors.family));
    return rows.map((r) => r.family);
  }

  /** Fetch the colors whose ids are in `ids` (used to validate image color sets). */
  async findManyByIds(ids: string[]): Promise<Color[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(colors).where(inArray(colors.id, ids));
  }

  async insert(input: NewColor): Promise<Color> {
    const [row] = await this.db.insert(colors).values(input).returning();
    return row;
  }

  async updateById(
    id: string,
    patch: Partial<NewColor>,
  ): Promise<Color | undefined> {
    const [row] = await this.db
      .update(colors)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(colors.id, id))
      .returning();
    return row;
  }

  async deleteById(id: string): Promise<Color | undefined> {
    const [row] = await this.db
      .delete(colors)
      .where(eq(colors.id, id))
      .returning();
    return row;
  }

  /**
   * Delete a color after moving every product-image tag that points at it onto
   * the sentinel, in ONE transaction so RESTRICT can never half-apply:
   *   1. count the distinct products affected (for the UI), before any change;
   *   2. dedupe — drop this color's tags on images that ALREADY carry the
   *      sentinel, so the reassignment can't collide with the
   *      (product_id, storage_key, color_id) primary key;
   *   3. reassign the remaining tags onto the sentinel;
   *   4. delete the color row — its synonyms cascade, and RESTRICT no longer
   *      blocks because no product_image_colors row references it anymore.
   * Returns undefined if the color was deleted concurrently mid-flight.
   *
   * This is the single place ColorsRepository writes product_image_colors: the
   * reassignment and the colors delete MUST be atomic, so the whole unit of work
   * lives in one transaction owned by the color's repository. The two reads/
   * writes keyed on `color_id` ride product_image_colors_color_id_idx.
   */
  async deleteWithReassignment(
    colorId: string,
    sentinelId: string,
  ): Promise<
    { reassignedImages: number; affectedProducts: number } | undefined
  > {
    return this.db.transaction(async (tx) => {
      const [affected] = await tx
        .select({
          value: sql<number>`count(distinct ${productImageColors.productId})::int`,
        })
        .from(productImageColors)
        .where(eq(productImageColors.colorId, colorId));
      const affectedProducts = affected?.value ?? 0;

      // Step 2 — dedupe to avoid a PK collision: delete this color's tag on any
      // image that is already tagged with the sentinel.
      const existing = alias(productImageColors, 'existing_tag');
      await tx.delete(productImageColors).where(
        and(
          eq(productImageColors.colorId, colorId),
          exists(
            tx
              .select({ one: sql`1` })
              .from(existing)
              .where(
                and(
                  eq(existing.productId, productImageColors.productId),
                  eq(existing.storageKey, productImageColors.storageKey),
                  eq(existing.colorId, sentinelId),
                ),
              ),
          ),
        ),
      );

      // Step 3 — reassign the survivors onto the sentinel.
      const reassigned = await tx
        .update(productImageColors)
        .set({ colorId: sentinelId })
        .where(eq(productImageColors.colorId, colorId))
        .returning({ productId: productImageColors.productId });
      const reassignedImages = reassigned.length;

      // Step 4 — drop the now-unreferenced color (synonyms cascade).
      const [deleted] = await tx
        .delete(colors)
        .where(eq(colors.id, colorId))
        .returning({ id: colors.id });
      if (!deleted) return undefined;

      return { reassignedImages, affectedProducts };
    });
  }
}
