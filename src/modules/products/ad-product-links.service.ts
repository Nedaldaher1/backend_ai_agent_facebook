import { Injectable, NotFoundException } from '@nestjs/common';
import type { ListOptions } from '@/common/types/query';
import {
  createAdProductLinkSchema,
  parseOrThrow,
  updateAdProductLinkSchema,
  type CreateAdProductLinkInput,
  type UpdateAdProductLinkInput,
} from '@/common/validation';
import {
  AdProductLinksRepository,
  type AdProductLinkFilter,
} from './ad-product-links.repository';
import type { AdProductLink } from './entities/ad-product-link.entity';
import { ProductsService } from './products.service';

/**
 * Admin CRUD for ad_product_links. Validates every write through the shared zod
 * schemas, and verifies that the referenced product exists before inserting or
 * updating, so the caller gets a clean 404 instead of an opaque FK violation.
 */
@Injectable()
export class AdProductLinksService {
  constructor(
    private readonly repo: AdProductLinksRepository,
    private readonly productsService: ProductsService,
  ) {}

  list(
    filter?: AdProductLinkFilter,
    opts?: ListOptions,
  ): Promise<AdProductLink[]> {
    return this.repo.list(filter, opts);
  }

  async getById(id: string): Promise<AdProductLink> {
    const row = await this.repo.findById(id);
    if (!row) {
      throw new NotFoundException(`Ad product link ${id} not found`);
    }
    return row;
  }

  async create(input: CreateAdProductLinkInput): Promise<AdProductLink> {
    const data = parseOrThrow(createAdProductLinkSchema, input);
    // Verify the product exists; productsService.getById throws NotFound if not.
    await this.productsService.getById(data.productId);
    return this.repo.insert(data);
  }

  async update(
    id: string,
    patch: UpdateAdProductLinkInput,
  ): Promise<AdProductLink> {
    const data = parseOrThrow(updateAdProductLinkSchema, patch);
    // Confirm the link exists first, so a missing link is reported as the 404
    // rather than masking it behind a "product not found" from the check below.
    await this.getById(id);
    if (data.productId !== undefined) {
      // Verify the replacement product exists before persisting.
      await this.productsService.getById(data.productId);
    }
    const row = await this.repo.updateById(id, data);
    if (!row) {
      throw new NotFoundException(`Ad product link ${id} not found`);
    }
    return row;
  }

  async delete(id: string): Promise<AdProductLink> {
    const row = await this.repo.deleteById(id);
    if (!row) {
      throw new NotFoundException(`Ad product link ${id} not found`);
    }
    return row;
  }
}
