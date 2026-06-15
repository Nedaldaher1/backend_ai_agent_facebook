import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  searchProductsSchema,
  type SearchProductsDto,
} from './dto/search-products.dto';
import { ProductsService } from './products.service';

/**
 * HTTP only — no business logic here. This is the customer/agent read surface;
 * only published products are reachable. Admin write routes will live behind an
 * auth guard (see common/guards) and are intentionally not exposed yet.
 */
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  search(
    @Query(new ZodValidationPipe(searchProductsSchema))
    query: SearchProductsDto,
  ) {
    return this.products.search(query);
  }

  @Get(':id')
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.getPublishedById(id);
  }
}
