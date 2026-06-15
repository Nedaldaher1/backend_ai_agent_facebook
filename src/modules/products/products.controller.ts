import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  searchProductsSchema,
  type SearchProductsDto,
} from './dto/search-products.dto';
import { ProductDto } from './dto/product.dto';
import { ProductsService } from './products.service';

/**
 * HTTP only — no business logic here. This is the customer/agent read surface;
 * only published products are reachable. Admin write routes will live behind an
 * auth guard (see common/guards) and are intentionally not exposed yet.
 */
@ApiTags('Products')
@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @ApiOperation({
    summary: 'Search the published catalog',
    description:
      'Returns published products matching the given attribute filters. The raw ' +
      '`color` term (possibly Jordanian dialect, e.g. "نبيتي") is normalized to a ' +
      'color family via color synonyms before matching. All filters are optional; ' +
      'with none, the full published catalog is returned.',
  })
  @ApiQuery({
    name: 'color',
    required: false,
    description:
      'Customer color term; normalized via color synonyms (e.g. "نبيتي" → red).',
    example: 'نبيتي',
  })
  @ApiQuery({
    name: 'colorFamily',
    required: false,
    description:
      'Canonical color family; takes precedence over `color` when provided.',
    example: 'red',
  })
  @ApiQuery({
    name: 'size',
    required: false,
    description: 'Requested size.',
    example: 'M',
  })
  @ApiQuery({
    name: 'fabric',
    required: false,
    description: 'Fabric filter.',
    example: 'crepe',
  })
  @ApiQuery({
    name: 'occasion',
    required: false,
    description: 'Occasion filter.',
    example: 'evening',
  })
  @ApiOkResponse({
    description: 'Matching published products.',
    type: [ProductDto],
  })
  @ApiBadRequestResponse({
    description: 'Unknown query parameter or invalid filter value.',
  })
  search(
    @Query(new ZodValidationPipe(searchProductsSchema))
    query: SearchProductsDto,
  ) {
    return this.products.search(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a published product by id' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product UUID.' })
  @ApiOkResponse({ description: 'The published product.', type: ProductDto })
  @ApiNotFoundResponse({
    description: 'No published product exists with that id.',
  })
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.products.getPublishedById(id);
  }
}
