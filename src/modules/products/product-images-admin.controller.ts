import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
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
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  setImageColorsSchema,
  setImageDescriptionSchema,
  type SetImageColorsInput,
  type SetImageDescriptionInput,
} from '@/common/validation';
import { BEARER_AUTH_NAME } from '@/core/openapi/openapi';
import {
  ImageWithColorsDto,
  SetImageColorsDto,
} from './dto/product-image-color.dto';
import {
  ImageWithDescriptionDto,
  SetImageDescriptionDto,
} from './dto/product-image-description.dto';
import type { Product } from './entities/product.entity';
import {
  ProductsService,
  type ImageWithColors,
  type ImageWithDescription,
} from './products.service';

/**
 * Admin image management routes for a product. Image keys (the `:imageId`
 * path segment) are flat storage keys like `<uuid>.<ext>` — they are NOT
 * UUIDs, so ParseUUIDPipe is intentionally not used for that parameter.
 *
 * Routes:
 *   GET    /admin/products/:id/images                  → list (key + url + isPrimary + colors)
 *   DELETE /admin/products/:id/images/:imageId         → delete one image
 *   PATCH  /admin/products/:id/images/:imageId/primary → promote to primary (index 0)
 *   PUT    /admin/products/:id/images/:imageId/colors  → set the image's colors
 *   PUT    /admin/products/:id/images/:imageId/description → set the image's description
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
      'Returns all images for the product as `{ key, url, isPrimary, colors }` ' +
      'objects. `url` is the public access URL resolved from the storage key. ' +
      '`isPrimary` is `true` only for the first entry (index 0). `colors` is the ' +
      'list of canonical colors attached to that image.',
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
          colors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                name: { type: 'string', example: 'أحمر' },
                family: { type: 'string', example: 'red' },
                hex: { type: 'string', nullable: true, example: '#B0212F' },
              },
            },
          },
        },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'No product exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  listImages(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ImageWithColors[]> {
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
  @ApiOkResponse({ description: 'Image deleted; updated product returned.' })
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
  @ApiOkResponse({ description: 'Primary image updated; updated product returned.' })
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

  @Put(':imageId/colors')
  @ApiOperation({
    summary: "Set a product image's colors",
    description:
      'Replaces the full set of canonical colors attached to one image. Every ' +
      'color id must reference an existing color (created via the colors / ' +
      'color-synonyms system) — an admin cannot attach a free-form color. ' +
      'Returns the image descriptor with the storage key resolved to a public URL.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product UUID.' })
  @ApiParam({
    name: 'imageId',
    description: 'Storage key of the image (e.g. `abc123.jpg`).',
  })
  @ApiBody({ type: SetImageColorsDto })
  @ApiOkResponse({
    description: 'Image colors updated.',
    type: ImageWithColorsDto,
  })
  @ApiNotFoundResponse({
    description: 'The product, the image key, or a given color id was not found.',
  })
  @ApiBadRequestResponse({
    description: 'The payload was invalid (e.g. empty `colorIds`).',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  setImageColors(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('imageId') imageId: string,
    @Body(new ZodValidationPipe(setImageColorsSchema)) dto: SetImageColorsInput,
  ): Promise<ImageWithColors> {
    return this.products.setImageColors(id, imageId, dto);
  }

  @Put(':imageId/description')
  @ApiOperation({
    summary: "Set a product image's description",
    description:
      'Sets (or replaces) the admin-authored description of one image. The text ' +
      'is embedded together with the image (one multimodal vector) so visual ' +
      'search matches on both the picture and the words. Refreshes the product ' +
      'embeddings best-effort. Returns the image descriptor with the storage key ' +
      'resolved to a public URL.',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Product UUID.' })
  @ApiParam({
    name: 'imageId',
    description: 'Storage key of the image (e.g. `abc123.jpg`).',
  })
  @ApiBody({ type: SetImageDescriptionDto })
  @ApiOkResponse({
    description: 'Image description updated.',
    type: ImageWithDescriptionDto,
  })
  @ApiNotFoundResponse({
    description: 'The product or the image key was not found.',
  })
  @ApiBadRequestResponse({
    description: 'The payload was invalid (empty or too-long `description`).',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  setImageDescription(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('imageId') imageId: string,
    @Body(new ZodValidationPipe(setImageDescriptionSchema))
    dto: SetImageDescriptionInput,
  ): Promise<ImageWithDescription> {
    return this.products.setImageDescription(id, imageId, dto);
  }
}
