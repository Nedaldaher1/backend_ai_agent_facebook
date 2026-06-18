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
  createColorSynonymSchema,
  updateColorSynonymSchema,
  type CreateColorSynonymInput,
  type UpdateColorSynonymInput,
} from '@/common/validation';
import { BEARER_AUTH_NAME } from '@/core/openapi/openapi';
import { ColorSynonymsService } from './color-synonyms.service';
import {
  ColorSynonymDto,
  CreateColorSynonymDto,
  UpdateColorSynonymDto,
} from './dto/color-synonym.dto';
import type { ColorSynonym } from './entities/color-synonym.entity';

/** Pagination-only query schema for the color-synonyms list. */
const colorSynonymsListQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();
type ColorSynonymsListQuery = z.infer<typeof colorSynonymsListQuerySchema>;

/**
 * Admin write/read surface for color_synonyms. All routes require a valid
 * Bearer JWT with role `admin` or `editor`.
 *
 * Route layout:
 *   POST   /admin/color-synonyms          → create a synonym
 *   GET    /admin/color-synonyms          → list (with optional pagination)
 *   PATCH  /admin/color-synonyms/:id      → update fields
 *   DELETE /admin/color-synonyms/:id      → hard delete
 */
@ApiTags('Color Synonyms')
@Controller('admin/color-synonyms')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'editor')
@ApiBearerAuth(BEARER_AUTH_NAME)
export class ColorSynonymsAdminController {
  constructor(private readonly colors: ColorSynonymsService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create a color synonym',
    description:
      'Maps a dialect color term (e.g. "نبيتي") to a canonical color family ' +
      '(e.g. "red") so the agent can normalize customer language during product search.',
  })
  @ApiBody({ type: CreateColorSynonymDto })
  @ApiCreatedResponse({ description: 'Synonym created.', type: ColorSynonymDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  create(
    @Body(new ZodValidationPipe(createColorSynonymSchema))
    dto: CreateColorSynonymInput,
  ): Promise<ColorSynonym> {
    return this.colors.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'List color synonyms (admin)',
    description: 'Paginated list of color synonym mappings, newest first.',
  })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiOkResponse({
    description: 'List of color synonyms.',
    type: [ColorSynonymDto],
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  list(
    @Query(new ZodValidationPipe(colorSynonymsListQuerySchema))
    query: ColorSynonymsListQuery,
  ): Promise<ColorSynonym[]> {
    return this.colors.list({ limit: query.limit, offset: query.offset });
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a color synonym',
    description: 'Partial (PATCH) update of a color synonym mapping.',
  })
  @ApiBody({ type: UpdateColorSynonymDto })
  @ApiOkResponse({ description: 'Synonym updated.', type: ColorSynonymDto })
  @ApiNotFoundResponse({ description: 'No synonym exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateColorSynonymSchema))
    dto: UpdateColorSynonymInput,
  ): Promise<ColorSynonym> {
    return this.colors.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Delete a color synonym',
    description: 'Hard-deletes the synonym row and returns the deleted row.',
  })
  @ApiOkResponse({ description: 'Synonym deleted.', type: ColorSynonymDto })
  @ApiNotFoundResponse({ description: 'No synonym exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<ColorSynonym> {
    return this.colors.delete(id);
  }
}
