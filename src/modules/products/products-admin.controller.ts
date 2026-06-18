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
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import type { PaginatedResult } from '@/common/types/query';
import {
  createProductSchema,
  updateProductSchema,
  type CreateProductInput,
  type UpdateProductInput,
} from '@/common/validation';
import { BEARER_AUTH_NAME } from '@/core/openapi/openapi';
import { ProductDto } from './dto/product.dto';
import type { Product } from './entities/product.entity';
import { ProductsService } from './products.service';

/** Schema for the publish-toggle body: accepts the snake_case API key. */
const publishBodySchema = z.object({ is_published: z.boolean() }).strict();
type PublishBody = z.infer<typeof publishBodySchema>;

/**
 * Query schema for the admin product list. `published` is coerced from the
 * 'true'/'false' string a query param arrives as. All fields are optional.
 */
const adminListQuerySchema = z
  .object({
    published: z
      .string()
      .optional()
      .transform((v) => {
        if (v === 'true') return true;
        if (v === 'false') return false;
        return undefined;
      }),
    limit: z.coerce.number().int().positive().optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();
type AdminListQuery = z.infer<typeof adminListQuerySchema>;

/**
 * Admin write surface for products. All routes require a valid Bearer JWT
 * with role `admin` or `editor`.
 *
 * Route layout:
 *   POST   /admin/products          → create draft
 *   PATCH  /admin/products/:id      → update fields
 *   DELETE /admin/products/:id      → hard delete
 *   PATCH  /admin/products/:id/publish → set published flag
 *   GET    /admin/products          → list (all, with optional published filter)
 */
@ApiTags('Admin')
@Controller('admin/products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'editor')
@ApiBearerAuth(BEARER_AUTH_NAME)
export class ProductsAdminController {
  constructor(private readonly products: ProductsService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create a product draft',
    description:
      'Creates a new product in draft state (is_published = false). The product ' +
      'will not be visible to customers or the agent until published.',
  })
  @ApiCreatedResponse({ description: 'Product draft created.', type: ProductDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  create(
    @Body(new ZodValidationPipe(createProductSchema)) dto: CreateProductInput,
  ): Promise<Product> {
    return this.products.create(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update product fields',
    description:
      'Partial (PATCH) update of a product. Only the supplied fields are changed. ' +
      'Drafts and published products are both reachable.',
  })
  @ApiOkResponse({ description: 'Product updated.', type: ProductDto })
  @ApiNotFoundResponse({ description: 'No product exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateProductSchema)) dto: UpdateProductInput,
  ): Promise<Product> {
    return this.products.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Delete a product',
    description: 'Hard-deletes the product row and returns the deleted product.',
  })
  @ApiOkResponse({ description: 'Product deleted.', type: ProductDto })
  @ApiNotFoundResponse({ description: 'No product exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<Product> {
    return this.products.delete(id);
  }

  @Patch(':id/publish')
  @ApiOperation({
    summary: 'Set the published flag',
    description:
      'Explicitly set `is_published` to `true` or `false`. Prefer this over ' +
      'toggling when the desired state is known.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['is_published'],
      properties: { is_published: { type: 'boolean' } },
    },
  })
  @ApiOkResponse({ description: 'Publish flag updated.', type: ProductDto })
  @ApiNotFoundResponse({ description: 'No product exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  setPublished(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(publishBodySchema)) dto: PublishBody,
  ): Promise<Product> {
    return this.products.setPublished(id, dto.is_published);
  }

  @Get()
  @ApiOperation({
    summary: 'List products (admin)',
    description:
      'Paginated product list visible to admins. Includes drafts by default. ' +
      'Pass `published=true` to narrow to published products only, or ' +
      '`published=false` to see only drafts.',
  })
  @ApiQuery({
    name: 'published',
    required: false,
    description: 'Filter by publish state.',
    example: 'true',
  })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiOkResponse({ description: 'Paginated product list.', type: [ProductDto] })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  list(
    @Query(new ZodValidationPipe(adminListQuerySchema)) query: AdminListQuery,
  ): Promise<PaginatedResult<Product>> {
    const { published, limit, offset } = query;
    return this.products.list(
      { isPublished: published },
      { limit, offset },
    );
  }
}
