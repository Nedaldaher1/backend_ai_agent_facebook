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
  ApiBadRequestResponse,
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
  createColorSchema,
  updateColorSchema,
  type CreateColorInput,
  type UpdateColorInput,
} from '@/common/validation';
import { BEARER_AUTH_NAME } from '@/core/openapi/openapi';
import { ColorsService } from './colors.service';
import { ColorSynonymsService } from './color-synonyms.service';
import {
  ColorDto,
  ColorUsageDto,
  CreateColorDto,
  DeleteColorResultDto,
  UpdateColorDto,
  type ColorUsage,
  type DeleteColorResult,
} from './dto/color.dto';
import type { Color } from './entities/color.entity';
import type { ColorSynonym } from './entities/color-synonym.entity';

/** Pagination-only query schema for the colors list. */
const colorsListQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();
type ColorsListQuery = z.infer<typeof colorsListQuerySchema>;

/** A color together with the dialect terms that resolve to it. */
type ColorWithSynonyms = Color & { synonyms: ColorSynonym[] };

/**
 * Admin write/read surface for `colors` — the canonical color entity that
 * dialect terms (color_synonyms) and product images are attached to. All routes
 * require a valid Bearer JWT with role `admin` or `editor`.
 *
 * Route layout:
 *   POST   /admin/colors                  → create a color
 *   GET    /admin/colors                  → list assignable colors (excludes system)
 *   GET    /admin/colors/unassigned/usage → "needs review" queue (sentinel usage)
 *   GET    /admin/colors/:id/usage        → usage report (pre-delete warning)
 *   GET    /admin/colors/:id              → one color with its dialect terms
 *   PATCH  /admin/colors/:id              → update (family change needs confirm)
 *   DELETE /admin/colors/:id              → safe delete (reassigns tags to sentinel)
 */
@ApiTags('Colors')
@Controller('admin/colors')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'editor')
@ApiBearerAuth(BEARER_AUTH_NAME)
export class ColorsAdminController {
  constructor(
    private readonly colors: ColorsService,
    private readonly synonyms: ColorSynonymsService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create a color',
    description:
      'Creates a canonical color. `family` is the stable search key (e.g. "red") ' +
      'that dialect terms resolve to; `name` is the display label (e.g. "أحمر"); ' +
      '`hex` is an optional UI swatch.',
  })
  @ApiBody({ type: CreateColorDto })
  @ApiCreatedResponse({ description: 'Color created.', type: ColorDto })
  @ApiConflictResponse({
    description:
      'A color with that `family` already exists (families are unique).',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  create(
    @Body(new ZodValidationPipe(createColorSchema)) dto: CreateColorInput,
  ): Promise<Color> {
    return this.colors.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List assignable colors (admin)',
    description:
      'Paginated list of canonical colors, newest first. System colors (e.g. the ' +
      '"غير معرف" sentinel) are excluded — this is the list used for tagging images.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiOkResponse({ description: 'List of colors.', type: [ColorDto] })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  list(
    @Query(new ZodValidationPipe(colorsListQuerySchema)) query: ColorsListQuery,
  ): Promise<Color[]> {
    return this.colors.list({ limit: query.limit, offset: query.offset });
  }

  @Get('unassigned/usage')
  @ApiOperation({
    summary: 'Sentinel usage ("needs review" queue)',
    description:
      'Products whose images are currently tagged with the "غير معرف" sentinel ' +
      '(i.e. their real color was deleted and needs re-tagging).',
  })
  @ApiOkResponse({
    description: 'Usage of the sentinel color.',
    type: ColorUsageDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  unassignedUsage(): Promise<ColorUsage> {
    return this.colors.unassignedUsage();
  }

  @Get(':id/usage')
  @ApiOperation({
    summary: 'Color usage (pre-delete warning)',
    description:
      'How many product images and distinct products use this color. The ' +
      '`products` array is distinct and capped at 50; `hasMore` is true when more ' +
      'products use the color than are listed.',
  })
  @ApiOkResponse({
    description: 'Usage report for the color.',
    type: ColorUsageDto,
  })
  @ApiNotFoundResponse({ description: 'No color exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  usage(@Param('id', ParseUUIDPipe) id: string): Promise<ColorUsage> {
    return this.colors.usage(id);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a color with its dialect terms',
    description:
      'Returns the color plus the list of color_synonyms (dialect terms) that ' +
      'resolve to it. System colors (the sentinel) are returned here for display ' +
      'even though they are excluded from the assignable list.',
  })
  @ApiOkResponse({ description: 'The color and its synonyms.', type: ColorDto })
  @ApiNotFoundResponse({ description: 'No color exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ColorWithSynonyms> {
    const color = await this.colors.getById(id);
    const synonyms = await this.synonyms.listByColor(id);
    return { ...color, synonyms };
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a color',
    description:
      'Partial (PATCH) update. `name`/`hex`/`isActive` change freely (image tags ' +
      'key off color_id and stay correct). Changing `family` re-points every ' +
      'dialect synonym and product search that resolves to this color, so it ' +
      'requires `?confirmFamilyChange=true`; without it the request is rejected ' +
      '(409). System colors cannot be modified (400).',
  })
  @ApiQuery({
    name: 'confirmFamilyChange',
    required: false,
    type: Boolean,
    description:
      'Set to true to allow changing `family`. Required only when `family` changes.',
  })
  @ApiBody({ type: UpdateColorDto })
  @ApiOkResponse({ description: 'Color updated.', type: ColorDto })
  @ApiBadRequestResponse({
    description: 'The color is a system color (immutable).',
  })
  @ApiNotFoundResponse({ description: 'No color exists with that id.' })
  @ApiConflictResponse({
    description:
      'A family change was requested without ?confirmFamilyChange=true, or the ' +
      'new `family` collides with an existing color (families are unique).',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateColorSchema)) dto: UpdateColorInput,
    @Query('confirmFamilyChange') confirmFamilyChange?: string,
  ): Promise<Color> {
    return this.colors.update(id, dto, confirmFamilyChange === 'true');
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Delete a color (reassigns its image tags to "غير معرف")',
    description:
      'Safe delete: in one transaction, every product image tagged with this ' +
      'color is reassigned to the "غير معرف" sentinel, then the color (and its ' +
      'dialect terms, via cascade) is removed. Returns the affected counts. ' +
      'System colors cannot be deleted (400).',
  })
  @ApiOkResponse({
    description: 'Color deleted and its image tags reassigned.',
    type: DeleteColorResultDto,
  })
  @ApiBadRequestResponse({
    description: 'The color is a system color and cannot be deleted.',
  })
  @ApiNotFoundResponse({ description: 'No color exists with that id.' })
  @ApiConflictResponse({
    description: 'The color was concurrently re-tagged on an image; retry.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<DeleteColorResult> {
    return this.colors.delete(id);
  }
}
