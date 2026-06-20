import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  UnsupportedMediaTypeException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
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
import { ALLOWED_IMAGE_MIME } from '@/core/storage/storage.constants';
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

  @Get('embedding-summary')
  @ApiOperation({
    summary: 'Per-product embedding counts',
    description:
      'Number of embedded product images per product for the current embedding ' +
      'model, powering the admin list\'s "indexed for visual search" badge. ' +
      'Products with no embeddings are omitted — treat a missing id as 0. ' +
      'Embeddings exist only for published products.',
  })
  @ApiOkResponse({
    description: 'Array of per-product embedded-image counts.',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          productId: { type: 'string', format: 'uuid' },
          embeddedCount: { type: 'integer', example: 3 },
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  embeddingSummary(): Promise<{ productId: string; embeddedCount: number }[]> {
    return this.products.embeddingSummary();
  }

  @Post('analyze-image')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Analyze a product image with the embedding model',
    description:
      'Runs a single uploaded image through the embedding model (Marqo-FashionSigLIP) ' +
      "as a real forward pass to validate it is processable — backs the admin form's " +
      'per-image "analyzed" indicator. The image is NOT stored; the searchable embedding ' +
      'is written on publish. Accepts multipart/form-data with one image file (jpeg/png/webp).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOkResponse({
    description: 'The image was analyzed by the model.',
    schema: {
      type: 'object',
      properties: {
        analyzed: { type: 'boolean', example: true },
        modelId: { type: 'string', example: 'Marqo/marqo-fashionSigLIP' },
      },
    },
  })
  @ApiBadRequestResponse({ description: 'No image file was provided.' })
  @ApiUnsupportedMediaTypeResponse({
    description: 'The file was not an allowed image type (jpeg/png/webp).',
  })
  @ApiPayloadTooLargeResponse({
    description: 'The file exceeded the maximum allowed size.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  async analyzeImage(
    @Req() req: FastifyRequest,
  ): Promise<{ analyzed: true; modelId: string }> {
    const buffer = await this.readUploadedImage(req);
    return this.products.analyzeImage(buffer);
  }

  /**
   * Read and validate a single uploaded image from a multipart request, returning
   * its in-memory buffer (no persistence). Mirrors the upload controller's checks
   * (mimetype + the @fastify/multipart size cap) but for exactly one file.
   */
  private async readUploadedImage(req: FastifyRequest): Promise<Buffer> {
    if (!req.isMultipart()) {
      throw new BadRequestException(
        'Expected a multipart/form-data request with an image file.',
      );
    }
    const part = await req.file();
    if (!part) {
      throw new BadRequestException('No image file was provided.');
    }
    if (!ALLOWED_IMAGE_MIME.has(part.mimetype)) {
      throw new UnsupportedMediaTypeException(
        `Unsupported file type "${part.mimetype}". Allowed: ${[
          ...ALLOWED_IMAGE_MIME,
        ].join(', ')}.`,
      );
    }
    try {
      return await part.toBuffer();
    } catch {
      throw new PayloadTooLargeException(
        'The image exceeds the maximum allowed size.',
      );
    }
  }
}
