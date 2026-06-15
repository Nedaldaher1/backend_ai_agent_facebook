import { Inject, Injectable } from '@nestjs/common';
import { and, arrayContains, eq, type SQL } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { colorSynonyms } from './entities/color-synonym.entity';
import {
  products,
  type NewProduct,
  type Product,
} from './entities/product.entity';

export interface ProductFilter {
  colorFamily?: string;
  size?: string;
  fabric?: string;
  occasion?: string;
}

/**
 * Sole owner of product SQL. Services call these methods; nothing above this
 * layer touches the database or builds queries.
 */
@Injectable()
export class ProductsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Customer/agent read path — publish gate enforced here. */
  async findPublished(filter: ProductFilter): Promise<Product[]> {
    const conditions: SQL[] = [eq(products.isPublished, true)];

    if (filter.colorFamily) {
      conditions.push(eq(products.colorFamily, filter.colorFamily));
    }
    if (filter.size) {
      conditions.push(arrayContains(products.sizes, [filter.size]));
    }
    if (filter.fabric) {
      conditions.push(eq(products.fabric, filter.fabric));
    }
    if (filter.occasion) {
      conditions.push(eq(products.occasion, filter.occasion));
    }

    return this.db
      .select()
      .from(products)
      .where(and(...conditions));
  }

  /** Internal lookup (no publish gate); callers decide whether to expose it. */
  async findById(id: string): Promise<Product | undefined> {
    const [row] = await this.db
      .select()
      .from(products)
      .where(eq(products.id, id))
      .limit(1);
    return row;
  }

  /** Resolve a dialect color term to its canonical family, or null if unknown. */
  async resolveColorFamily(term: string): Promise<string | null> {
    const [row] = await this.db
      .select({ canonicalFamily: colorSynonyms.canonicalFamily })
      .from(colorSynonyms)
      .where(eq(colorSynonyms.term, term))
      .limit(1);
    return row?.canonicalFamily ?? null;
  }

  /** Admin write path — new products start unpublished (draft). */
  async insertDraft(input: NewProduct): Promise<Product> {
    const [row] = await this.db
      .insert(products)
      .values({ ...input, isPublished: false })
      .returning();
    return row;
  }

  async setPublished(
    id: string,
    isPublished: boolean,
  ): Promise<Product | undefined> {
    const [row] = await this.db
      .update(products)
      .set({ isPublished, updatedAt: new Date() })
      .where(eq(products.id, id))
      .returning();
    return row;
  }
}
