import {
  BadRequestException,
  Controller,
  Param,
  ParseUUIDPipe,
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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import { type MultipartFile } from '@fastify/multipart';
import type { FastifyRequest } from 'fastify';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { ALLOWED_IMAGE_MIME } from '@/core/storage/storage.constants';
import { BEARER_AUTH_NAME } from '@/core/openapi/openapi';
import { ProductDto } from './dto/product.dto';
import type { Product } from './entities/product.entity';
import { ProductsService, type UploadedImage } from './products.service';

/**
 * Admin write surface for product images. Files arrive as multipart/form-data,
 * are buffered in memory (no temp files — @fastify/multipart), validated by
 * mimetype + size, then handed to ProductsService, which persists them through
 * the storage layer and records their URLs on the product.
 *
 * Admin action: requires a valid Bearer JWT with role `admin` or `editor`.
 */
@ApiTags('Admin')
@Controller('products/:id/images')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'editor')
@ApiBearerAuth(BEARER_AUTH_NAME)
export class ProductImagesController {
  constructor(private readonly products: ProductsService) {}

  @Post()
  @ApiOperation({
    summary: 'Upload one or more images for a product',
    description:
      'Accepts multipart/form-data with one or more image files (jpeg/png/webp). ' +
      'Each file is stored via the storage layer and its storage key is appended ' +
      "to the product's image_urls; the response returns the product with keys " +
      'resolved to public URLs. Pass `replace=true` to overwrite instead.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product UUID.' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
        },
      },
    },
  })
  @ApiQuery({
    name: 'replace',
    required: false,
    description: 'When `true`, replaces image_urls instead of appending.',
    example: false,
  })
  @ApiOkResponse({ description: 'The updated product.', type: ProductDto })
  @ApiNotFoundResponse({ description: 'No product exists with that id.' })
  @ApiBadRequestResponse({ description: 'The request carried no files.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  @ApiUnsupportedMediaTypeResponse({
    description: 'A file was not an allowed image type (jpeg/png/webp).',
  })
  @ApiPayloadTooLargeResponse({
    description: 'A file exceeded the maximum allowed size.',
  })
  async upload(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: FastifyRequest,
    @Query('replace') replace?: string,
  ): Promise<Product> {
    const files = await this.collectFiles(req);
    return this.products.addImages(id, files, { replace: replace === 'true' });
  }

  /**
   * Drain the multipart request into validated in-memory files. Mimetype is
   * checked before buffering so disallowed uploads are rejected early; the
   * per-file size cap is enforced by @fastify/multipart (configured in main.ts).
   */
  private async collectFiles(req: FastifyRequest): Promise<UploadedImage[]> {
    if (!req.isMultipart()) {
      throw new BadRequestException(
        'Expected a multipart/form-data request with one or more files.',
      );
    }

    const files: UploadedImage[] = [];
    for await (const part of req.files()) {
      this.assertImage(part);
      let buffer: Buffer;
      try {
        buffer = await part.toBuffer();
      } catch {
        // @fastify/multipart throws once a file crosses the fileSize limit.
        throw new PayloadTooLargeException(
          `File "${part.filename}" exceeds the maximum allowed size.`,
        );
      }
      files.push({ buffer, filename: part.filename });
    }

    if (files.length === 0) {
      throw new BadRequestException('No files were provided.');
    }
    return files;
  }

  private assertImage(part: MultipartFile): void {
    if (!ALLOWED_IMAGE_MIME.has(part.mimetype)) {
      throw new UnsupportedMediaTypeException(
        `Unsupported file type "${part.mimetype}". Allowed: ${[
          ...ALLOWED_IMAGE_MIME,
        ].join(', ')}.`,
      );
    }
  }
}
