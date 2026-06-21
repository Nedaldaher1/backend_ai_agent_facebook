import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { ListOptions } from '@/common/types/query';
import {
  createColorSchema,
  parseOrThrow,
  updateColorSchema,
  type CreateColorInput,
  type UpdateColorInput,
} from '@/common/validation';
import { ColorsRepository } from './colors.repository';
import { ProductImageColorsRepository } from './product-image-colors.repository';
import type { ColorUsage, DeleteColorResult } from './dto/color.dto';
import { UNASSIGNED_COLOR_FAMILY, type Color } from './entities/color.entity';

/** Postgres SQLSTATEs we translate into clean HTTP responses. */
const PG_FK_VIOLATION = '23503'; // a color still attached to an image (RESTRICT)
const PG_UNIQUE_VIOLATION = '23505'; // a duplicate family (colors_family_idx)

/** Distinct products listed in a usage report before `hasMore` kicks in. */
const USAGE_PRODUCT_CAP = 50;

/** True when `err` is a node-postgres driver error carrying the given SQLSTATE. */
function isPgError(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === code
  );
}

/**
 * The 409 message shown when a write collides with the unique `family` index.
 * `family` is the canonical search key (one color per family), so a duplicate is
 * an actionable conflict, not a server fault.
 */
function duplicateFamilyMessage(family: string | undefined): string {
  return (
    `A color with family "${family}" already exists. \`family\` is the canonical ` +
    `search key and must be unique across colors — pick a different family, or ` +
    `edit the existing color instead of creating a new one.`
  );
}

/**
 * Canonical-color logic. Owns the admin CRUD for the `colors` table and the
 * existence checks other services rely on (ColorSynonymsService verifies a
 * color before attaching a term; ProductsService verifies a color before
 * tagging an image), so the caller always gets a clean 404 instead of an opaque
 * FK violation.
 *
 * Deleting a color never strands its image tags: they are reassigned to the
 * reserved "__unassigned__" sentinel ("غير معرف") in one transaction. The
 * sentinel is itself a system color — undeletable and uneditable.
 */
@Injectable()
export class ColorsService {
  /**
   * Cached id of the seeded "__unassigned__" sentinel. The row is immutable
   * (system colors can't be edited or deleted), so its id is stable for the
   * process lifetime — resolve once by family, then reuse.
   */
  private sentinelId: string | null = null;

  constructor(
    private readonly repo: ColorsRepository,
    private readonly imageColors: ProductImageColorsRepository,
  ) {}

  list(opts?: ListOptions): Promise<Color[]> {
    return this.repo.list(opts);
  }

  /**
   * Canonical color families offered to customers — the closed-enum source for
   * vision image-attribute extraction. System sentinel excluded.
   */
  listActiveFamilies(): Promise<string[]> {
    return this.repo.distinctFamilies();
  }

  async getById(id: string): Promise<Color> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException(`Color ${id} not found`);
    }
    return row;
  }

  /**
   * Fetch many colors by id, asserting that EVERY id exists. Throws
   * NotFoundException naming the missing id(s) — used to validate the color set
   * an admin attaches to a product image before it reaches the FK.
   */
  async getManyByIds(ids: string[]): Promise<Color[]> {
    const unique = [...new Set(ids)];
    const rows = await this.repo.findManyByIds(unique);
    if (rows.length !== unique.length) {
      const found = new Set(rows.map((r) => r.id));
      const missing = unique.filter((id) => !found.has(id));
      throw new NotFoundException(`Unknown color id(s): ${missing.join(', ')}`);
    }
    return rows;
  }

  /**
   * Insert a new canonical color. Validation stays a synchronous fail-fast (a
   * bad payload throws before any DB round-trip); only the insert's rejection is
   * wrapped, so a duplicate `family` (the unique search key) surfaces as a clean
   * 409 instead of a raw driver 500. Kept non-async to preserve the sync throw.
   */
  create(input: CreateColorInput): Promise<Color> {
    const data = parseOrThrow(createColorSchema, input);
    return this.repo.insert(data).catch((err: unknown) => {
      if (isPgError(err, PG_UNIQUE_VIOLATION)) {
        throw new ConflictException(duplicateFamilyMessage(data.family));
      }
      throw err;
    });
  }

  /**
   * Partial update. `name`/`hex`/`isActive` are free to change — image tags key
   * off the immutable color_id, so they stay correct. Changing `family` is
   * different: it re-points every dialect synonym and product search that
   * resolves to this color, so it requires explicit `confirmFamilyChange`.
   * System colors (the sentinel) are immutable and reject any edit.
   */
  async update(
    id: string,
    patch: UpdateColorInput,
    confirmFamilyChange = false,
  ): Promise<Color> {
    const data = parseOrThrow(updateColorSchema, patch);
    const current = await this.repo.findById(id);
    if (!current) {
      throw new NotFoundException(`Color ${id} not found`);
    }
    if (current.isSystem) {
      throw new BadRequestException(
        `Color ${id} is a system color and cannot be modified`,
      );
    }
    if (
      data.family !== undefined &&
      data.family !== current.family &&
      !confirmFamilyChange
    ) {
      throw new ConflictException(
        `Changing this color's family ("${current.family}" → "${data.family}") ` +
          `re-points every dialect synonym and product search that resolves to ` +
          `it. Re-send with ?confirmFamilyChange=true to proceed, or delete this ` +
          `color and create a new one to replace its meaning.`,
      );
    }
    let row: Color | undefined;
    try {
      row = await this.repo.updateById(id, data);
    } catch (err) {
      // Confirming a family change still has to clear the unique index; a
      // collision with another color's family is a 409, not a 500.
      if (isPgError(err, PG_UNIQUE_VIOLATION)) {
        throw new ConflictException(duplicateFamilyMessage(data.family));
      }
      throw err;
    }
    if (!row) {
      throw new NotFoundException(`Color ${id} not found`);
    }
    return row;
  }

  /**
   * Safe delete: reassign every image tag pointing at this color to the
   * "غير معرف" sentinel, then drop the color — all in one transaction. The
   * sentinel itself (any system color) cannot be deleted. Returns the counts the
   * UI needs to confirm what happened.
   */
  async delete(id: string): Promise<DeleteColorResult> {
    const color = await this.repo.findById(id);
    if (!color) {
      throw new NotFoundException(`Color ${id} not found`);
    }
    if (color.isSystem) {
      throw new BadRequestException(
        `Color ${id} ("${color.name}") is a system color and cannot be deleted`,
      );
    }
    const sentinelId = await this.resolveSentinelId();
    try {
      const result = await this.repo.deleteWithReassignment(id, sentinelId);
      if (!result) {
        throw new NotFoundException(`Color ${id} not found`);
      }
      return { deleted: true, ...result };
    } catch (err) {
      // The reassignment removes every reference, so RESTRICT should not fire;
      // a 23503 here means the color was re-tagged on an image concurrently.
      if (isPgError(err, PG_FK_VIOLATION)) {
        throw new ConflictException(
          `Color ${id} was re-tagged on an image while being deleted; please retry`,
        );
      }
      throw err;
    }
  }

  /**
   * Usage report for a color (pre-delete warning). Works for the sentinel too,
   * so it doubles as the data source for the "needs review" screen.
   */
  async usage(id: string): Promise<ColorUsage> {
    // 404 if the color is gone; the sentinel stays fetchable, so usage(sentinel)
    // is valid.
    await this.getById(id);
    const { productCount, imageCount, products } =
      await this.imageColors.colorUsage(id, USAGE_PRODUCT_CAP);
    return {
      productCount,
      imageCount,
      products,
      hasMore: productCount > products.length,
    };
  }

  /** Usage of the "__unassigned__" sentinel — the admin "needs review" queue. */
  async unassignedUsage(): Promise<ColorUsage> {
    const sentinelId = await this.resolveSentinelId();
    return this.usage(sentinelId);
  }

  private async resolveSentinelId(): Promise<string> {
    if (this.sentinelId) {
      return this.sentinelId;
    }
    const sentinel = await this.repo.findByFamily(UNASSIGNED_COLOR_FAMILY);
    if (!sentinel) {
      throw new InternalServerErrorException(
        `System color "${UNASSIGNED_COLOR_FAMILY}" is not seeded; run migration 0006.`,
      );
    }
    this.sentinelId = sentinel.id;
    return sentinel.id;
  }
}
