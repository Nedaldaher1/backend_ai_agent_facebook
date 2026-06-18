import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { BEARER_AUTH_NAME } from '@/core/openapi/openapi';
import { ProductDto } from './dto/product.dto';
import type { Product } from './entities/product.entity';
import { ProductsService } from './products.service';

/**
 * Admin image management routes for a product. Image keys (the `:imageId`
 * path segment) are flat storage keys like `<uuid>.<ext>` — they are NOT
 * UUIDs, so ParseUUIDPipe is intentionally not used for that parameter.
 *
 * Routes:
 *   GET    /admin/products/:id/images                 → list (key + url + isPrimary)
 *   DELETE /admin/products/:id/images/:imageId        → delete one image
 *   PATCH  /admin/products/:id/images/:imageId/primary → promote to primary (index 0)
 */
@ApiTags('Admin')
@Controller('admin/products/:id/images')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'editor')
@ApiBearerAuth(BEARER_AUTH_NAME)
export class ProductImagesAdminController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @ApiOperation({
    summary: 'List product images',
    description:
      'Returns all images for the product as `{ key, url, isPrimary }` objects. ' +
      '`url` is the public access URL resolved from the storage key. ' +
      '`isPrimary` is `true` only for the first entry (index 0).',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product UUID.' })
  @ApiOkResponse({
    description: 'Array of image descriptors.',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', example: 'abc123.jpg' },
          url: { type: 'string', format: 'uri' },
          isPrimary: { type: 'boolean' },
        },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'No product exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  listImages(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ key: string; url: string; isPrimary: boolean }[]> {
    return this.products.listImages(id);
  }

  @Delete(':imageId')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Delete a product image',
    description:
      'Removes the image from storage (R2) and strips its key from the product. ' +
      'Returns the updated product with image keys resolved to public URLs.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product UUID.' })
  @ApiParam({
    name: 'imageId',
    description: 'Storage key of the image (e.g. `abc123.jpg`).',
  })
  @ApiOkResponse({
    description: 'Image deleted; updated product returned.',
    type: ProductDto,
  })
  @ApiNotFoundResponse({
    description: 'No product exists with that id, or the key is not present.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  removeImage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('imageId') imageId: string,
  ): Promise<Product> {
    return this.products.removeImage(id, imageId);
  }

  @Patch(':imageId/primary')
  @ApiOperation({
    summary: 'Promote an image to primary',
    description:
      'Reorders `imageUrls` so the given key appears at index 0 (primary). ' +
      'The remaining keys keep their relative order. ' +
      'Returns the updated product with image keys resolved to public URLs.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product UUID.' })
  @ApiParam({
    name: 'imageId',
    description: 'Storage key of the image to promote.',
  })
  @ApiOkResponse({
    description: 'Primary image updated; updated product returned.',
    type: ProductDto,
  })
  @ApiNotFoundResponse({
    description: 'No product exists with that id, or the key is not present.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  setPrimaryImage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('imageId') imageId: string,
  ): Promise<Product> {
    return this.products.setPrimaryImage(id, imageId);
  }
}
