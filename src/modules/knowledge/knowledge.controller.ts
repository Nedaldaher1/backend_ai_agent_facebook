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
import type { PaginatedResult } from '@/common/types/query';
import {
  createKnowledgeEntrySchema,
  updateKnowledgeEntrySchema,
  type CreateKnowledgeEntryInput,
  type UpdateKnowledgeEntryInput,
} from '@/common/validation';
import { BEARER_AUTH_NAME } from '@/core/openapi/openapi';
import {
  CreateKnowledgeEntryDto,
  KnowledgeEntryDto,
  UpdateKnowledgeEntryDto,
} from './dto/knowledge-entry.dto';
import type { KnowledgeEntry } from './entities/knowledge-entry.entity';
import { KnowledgeService } from './knowledge.service';

/** Schema for the publish body: accepts the snake_case API key. */
const publishBodySchema = z.object({ is_published: z.boolean() }).strict();
type PublishBody = z.infer<typeof publishBodySchema>;

/**
 * Query schema for the admin knowledge list. `published` is coerced from the
 * 'true'/'false' string a query param arrives as. All fields are optional.
 */
const adminListQuerySchema = z
  .object({
    category: z.string().optional(),
    product_id: z.string().uuid().optional(),
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
 * Admin write/read surface for knowledge entries. All routes require a valid
 * Bearer JWT with role `admin` or `editor`.
 *
 * Route layout:
 *   POST   /admin/knowledge          → create draft
 *   PATCH  /admin/knowledge/:id      → update fields
 *   DELETE /admin/knowledge/:id      → hard delete
 *   PATCH  /admin/knowledge/:id/publish → set published flag
 *   GET    /admin/knowledge          → list (all, with optional filters; includes drafts)
 */
@ApiTags('Admin')
@Controller('admin/knowledge')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'editor')
@ApiBearerAuth(BEARER_AUTH_NAME)
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create a knowledge entry draft',
    description:
      'Creates a new knowledge entry in draft state (isPublished = false by default). ' +
      'The entry will not be visible to the agent until published. ' +
      'Pass productId to associate the entry with a specific product.',
  })
  @ApiBody({ type: CreateKnowledgeEntryDto })
  @ApiCreatedResponse({
    description: 'Knowledge entry draft created.',
    type: KnowledgeEntryDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  @ApiNotFoundResponse({
    description:
      'No product exists with that productId (when productId is provided).',
  })
  create(
    @Body(new ZodValidationPipe(createKnowledgeEntrySchema))
    dto: CreateKnowledgeEntryInput,
  ): Promise<KnowledgeEntry> {
    return this.knowledge.create(dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update knowledge entry fields',
    description:
      'Partial (PATCH) update of a knowledge entry. Only the supplied fields are changed. ' +
      'Drafts and published entries are both reachable.',
  })
  @ApiBody({ type: UpdateKnowledgeEntryDto })
  @ApiOkResponse({
    description: 'Knowledge entry updated.',
    type: KnowledgeEntryDto,
  })
  @ApiNotFoundResponse({ description: 'No entry exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateKnowledgeEntrySchema))
    dto: UpdateKnowledgeEntryInput,
  ): Promise<KnowledgeEntry> {
    return this.knowledge.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Delete a knowledge entry',
    description:
      'Hard-deletes the knowledge entry row and returns the deleted entry.',
  })
  @ApiOkResponse({
    description: 'Knowledge entry deleted.',
    type: KnowledgeEntryDto,
  })
  @ApiNotFoundResponse({ description: 'No entry exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<KnowledgeEntry> {
    return this.knowledge.delete(id);
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
  @ApiOkResponse({
    description: 'Publish flag updated.',
    type: KnowledgeEntryDto,
  })
  @ApiNotFoundResponse({ description: 'No entry exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  setPublished(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(publishBodySchema)) dto: PublishBody,
  ): Promise<KnowledgeEntry> {
    return this.knowledge.setPublished(id, dto.is_published);
  }

  @Get()
  @ApiOperation({
    summary: 'List knowledge entries (admin)',
    description:
      'Paginated knowledge entry list visible to admins. Includes drafts by default. ' +
      'Pass `published=true` to narrow to published entries only, or ' +
      '`published=false` to see only drafts. Pass `product_id` to filter by product.',
  })
  @ApiQuery({
    name: 'category',
    required: false,
    description: 'Filter by category.',
  })
  @ApiQuery({
    name: 'product_id',
    required: false,
    description: 'Filter by product UUID.',
  })
  @ApiQuery({
    name: 'published',
    required: false,
    description: 'Filter by publish state.',
    example: 'true',
  })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiOkResponse({ description: 'Paginated knowledge entry list.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  list(
    @Query(new ZodValidationPipe(adminListQuerySchema)) query: AdminListQuery,
  ): Promise<PaginatedResult<KnowledgeEntry>> {
    const { category, product_id, published, limit, offset } = query;
    return this.knowledge.list(
      { category, productId: product_id, isPublished: published },
      { limit, offset },
    );
  }
}
