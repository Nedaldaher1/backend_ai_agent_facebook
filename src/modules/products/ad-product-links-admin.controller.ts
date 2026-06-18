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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiCreatedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import {
  createAdProductLinkSchema,
  updateAdProductLinkSchema,
  type CreateAdProductLinkInput,
  type UpdateAdProductLinkInput,
} from '@/common/validation';
import { BEARER_AUTH_NAME } from '@/core/openapi/openapi';
import { AdProductLinksService } from './ad-product-links.service';
import {
  AdProductLinkDto,
  CreateAdProductLinkDto,
  UpdateAdProductLinkDto,
} from './dto/ad-product-link.dto';
import type { AdProductLink } from './entities/ad-product-link.entity';

/**
 * Query schema for the admin ad-links list. Accepts an optional `ad_ref`
 * (snake_case, matching HTTP convention) plus standard pagination.
 */
const adLinksListQuerySchema = z
  .object({
    ad_ref: z.string().optional(),
    limit: z.coerce.number().int().positive().optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();
type AdLinksListQuery = z.infer<typeof adLinksListQuerySchema>;

/**
 * Admin write/read surface for ad_product_links. All routes require a valid
 * Bearer JWT with role `admin` or `editor`.
 *
 * Route layout:
 *   POST   /admin/ad-links           → create a new link
 *   GET    /admin/ad-links           → list (optional ?ad_ref= filter + pagination)
 *   PATCH  /admin/ad-links/:id       → update fields (covers toggling isActive/position)
 *   DELETE /admin/ad-links/:id       → hard delete
 */
@ApiTags('Ad Links')
@Controller('admin/ad-links')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'editor')
@ApiBearerAuth(BEARER_AUTH_NAME)
export class AdProductLinksAdminController {
  constructor(private readonly adLinks: AdProductLinksService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create an ad-product link',
    description:
      'Links a product to a Facebook ad reference slug. The linked product will be ' +
      'surfaced by the agent when a customer arrives from that ad (is_active = true).',
  })
  @ApiBody({ type: CreateAdProductLinkDto })
  @ApiCreatedResponse({ description: 'Link created.', type: AdProductLinkDto })
  @ApiNotFoundResponse({ description: 'Referenced product does not exist.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  create(
    @Body(new ZodValidationPipe(createAdProductLinkSchema))
    dto: CreateAdProductLinkInput,
  ): Promise<AdProductLink> {
    return this.adLinks.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List ad-product links (admin)',
    description:
      'Returns links ordered by position asc then created_at asc. ' +
      'Pass `ad_ref` to narrow to a single ad reference slug.',
  })
  @ApiQuery({
    name: 'ad_ref',
    required: false,
    description: 'Filter by ad reference slug.',
    example: 'summer_2025_abaya',
  })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiOkResponse({
    description: 'List of ad-product links.',
    type: [AdProductLinkDto],
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  list(
    @Query(new ZodValidationPipe(adLinksListQuerySchema)) query: AdLinksListQuery,
  ): Promise<AdProductLink[]> {
    const { ad_ref, limit, offset } = query;
    return this.adLinks.list(
      { adRef: ad_ref },
      { limit, offset },
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an ad-product link',
    description:
      'Partial (PATCH) update of an ad-product link. Covers toggling `isActive` ' +
      '(deactivating a link removes it from the agent\'s ad-ref results without ' +
      'deleting it) and reordering via `position`.',
  })
  @ApiBody({ type: UpdateAdProductLinkDto })
  @ApiOkResponse({ description: 'Link updated.', type: AdProductLinkDto })
  @ApiNotFoundResponse({ description: 'No link or product exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateAdProductLinkSchema))
    dto: UpdateAdProductLinkInput,
  ): Promise<AdProductLink> {
    return this.adLinks.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Delete an ad-product link',
    description: 'Hard-deletes the link row and returns the deleted row.',
  })
  @ApiOkResponse({ description: 'Link deleted.', type: AdProductLinkDto })
  @ApiNotFoundResponse({ description: 'No link exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<AdProductLink> {
    return this.adLinks.delete(id);
  }
}
