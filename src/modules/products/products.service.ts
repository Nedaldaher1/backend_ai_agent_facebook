import { Injectable, NotFoundException } from '@nestjs/common';
import { ProductsRepository } from './products.repository';
import type { NewProduct, Product } from './entities/product.entity';

export interface ProductSearchInput {
  color?: string;
  colorFamily?: string;
  size?: string;
  fabric?: string;
  occasion?: string;
}

/**
 * Product business logic. This is the only surface other modules (e.g. the
 * agent) are allowed to touch — they import ProductsModule and call this.
 */
@Injectable()
export class ProductsService {
  constructor(private readonly repo: ProductsRepository) {}

  /**
   * Search the published catalog. A raw `color` term is normalized to a color
   * family through color_synonyms before filtering (e.g. "نبيتي" -> "red").
   */
  async search(input: ProductSearchInput): Promise<Product[]> {
    let colorFamily = input.colorFamily;
    if (!colorFamily && input.color) {
      // TODO: if no synonym matches, consider falling back to a direct color match.
      colorFamily =
        (await this.repo.resolveColorFamily(input.color)) ?? undefined;
    }

    return this.repo.findPublished({
      colorFamily,
      size: input.size,
      fabric: input.fabric,
      occasion: input.occasion,
    });
  }

  /** Fetch a single product, enforcing the publish gate for customer-facing reads. */
  async getPublishedById(id: string): Promise<Product> {
    const product = await this.repo.findById(id);
    if (!product || !product.isPublished) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return product;
  }

  // --- Admin write path (to be exposed via guarded routes / admin module) ---

  createDraft(input: NewProduct): Promise<Product> {
    return this.repo.insertDraft(input);
  }

  async publish(id: string): Promise<Product> {
    const product = await this.repo.setPublished(id, true);
    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }
    return product;
  }
}
