import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  createProductCategorySchema,
  updateProductCategorySchema,
  type CreateProductCategoryInput,
  type UpdateProductCategoryInput,
} from '@/common/validation';
import { BEARER_AUTH_NAME } from '@/core/openapi/openapi';
import { ProductCategoriesService } from './product-categories.service';
import {
  CreateProductCategoryDto,
  DeleteProductCategoryResultDto,
  ProductCategoryDto,
  UpdateProductCategoryDto,
  type DeleteProductCategoryResult,
} from './dto/product-category.dto';
import type { ProductCategory } from './entities/product-category.entity';

/** Pagination-only query schema for the categories list. */
const categoriesListQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();
type CategoriesListQuery = z.infer<typeof categoriesListQuerySchema>;

/**
 * Admin write/read surface for `product_categories` — the clothing categories a
 * product is tagged with, each carrying its own attribute schema. All routes
 * require a valid Bearer JWT with role `admin` or `editor`.
 *
 * Route layout:
 *   POST   /admin/product-categories       → create a category
 *   GET    /admin/product-categories        → list categories
 *   GET    /admin/product-categories/:id    → one category
 *   PATCH  /admin/product-categories/:id    → update (name/slug/schema/order/active)
 *   DELETE /admin/product-categories/:id    → delete (refused while in use)
 */
@ApiTags('Product Categories')
@Controller('admin/product-categories')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'editor')
@ApiBearerAuth(BEARER_AUTH_NAME)
export class ProductCategoriesAdminController {
  constructor(private readonly categories: ProductCategoriesService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create a clothing category',
    description:
      'Creates a category. `slug` is the stable English key (e.g. "abaya") used ' +
      'by search; `name` is the Arabic display label ("عباية"); ' +
      '`attributeSchema` lists the structured attributes products of this ' +
      'category expose.',
  })
  @ApiBody({ type: CreateProductCategoryDto })
  @ApiCreatedResponse({
    description: 'Category created.',
    type: ProductCategoryDto,
  })
  @ApiConflictResponse({
    description:
      'A category with that `slug` already exists (slugs are unique).',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  create(
    @Body(new ZodValidationPipe(createProductCategorySchema))
    dto: CreateProductCategoryInput,
  ): Promise<ProductCategory> {
    return this.categories.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List clothing categories (admin)',
    description:
      'Categories ordered by sort order then name. Includes inactive ones so the ' +
      'admin can re-enable them.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiOkResponse({
    description: 'List of categories.',
    type: [ProductCategoryDto],
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  list(
    @Query(new ZodValidationPipe(categoriesListQuerySchema))
    query: CategoriesListQuery,
  ): Promise<ProductCategory[]> {
    return this.categories.list({ limit: query.limit, offset: query.offset });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a clothing category' })
  @ApiOkResponse({ description: 'The category.', type: ProductCategoryDto })
  @ApiNotFoundResponse({ description: 'No category exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  getOne(@Param('id', ParseUUIDPipe) id: string): Promise<ProductCategory> {
    return this.categories.getById(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a clothing category',
    description:
      'Partial (PATCH) update of name/slug/attributeSchema/sortOrder/isActive.',
  })
  @ApiBody({ type: UpdateProductCategoryDto })
  @ApiOkResponse({ description: 'Category updated.', type: ProductCategoryDto })
  @ApiNotFoundResponse({ description: 'No category exists with that id.' })
  @ApiConflictResponse({
    description: 'The new `slug` collides with an existing category.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateProductCategorySchema))
    dto: UpdateProductCategoryInput,
  ): Promise<ProductCategory> {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Delete a clothing category',
    description:
      'Deletes a category. Refused (409) while any product still references it — ' +
      'reassign or remove those products first.',
  })
  @ApiOkResponse({
    description: 'Category deleted.',
    type: DeleteProductCategoryResultDto,
  })
  @ApiNotFoundResponse({ description: 'No category exists with that id.' })
  @ApiConflictResponse({
    description: 'The category is still used by one or more products.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DeleteProductCategoryResult> {
    return this.categories.delete(id);
  }
}
