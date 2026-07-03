/**
 * ConversationsAdminController — admin REST surface for conversation control
 * and human-handoff (WS5 + WS6 — AIA-34).
 *
 * Route base: admin/conversations
 *
 * All routes are guarded by JwtAuthGuard + RolesGuard (role admin or editor),
 * identical to the pattern used in OrdersAdminController. SecurityModule (which
 * AgentModule imports via ConversationsModule's parent AppModule chain) supplies
 * JwtModule + both guards.
 *
 * Authentication wiring: AgentModule imports SecurityModule (transitively via
 * the imports chain in AppModule). The controller declares @UseGuards directly —
 * no global guard — mirroring OrdersModule.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { ZodValidationPipe } from '@/common/pipes/zod-validation.pipe';
import { BEARER_AUTH_NAME } from '@/core/openapi/openapi';
import { AI_STATES } from './entities/conversation.entity';
import { ConversationControlService } from './conversation-control.service';
import {
  assignConversationSchema,
  CONVERSATION_SORT_KEYS,
  ConversationListResponseDto,
  ConversationThreadDto,
  handoffConversationSchema,
  humanMessageSchema,
  listConversationsQuerySchema,
  pauseConversationSchema,
  pinConversationSchema,
  resumeConversationSchema,
  type AssignConversationInput,
  type HandoffConversationInput,
  type HumanMessageInput,
  type ListConversationsQuery,
  type PauseConversationInput,
  type PinConversationInput,
  type ResumeConversationInput,
} from './dto/conversation-control.dto';

@ApiTags('Conversations')
@Controller('admin/conversations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'editor')
@ApiBearerAuth(BEARER_AUTH_NAME)
export class ConversationsAdminController {
  constructor(private readonly control: ConversationControlService) {}

  // ---------------------------------------------------------------------------
  // GET /admin/conversations
  // ---------------------------------------------------------------------------

  @Get()
  @ApiOperation({
    summary: 'List conversations (admin)',
    description:
      'Paginated list of conversation threads with optional filters. ' +
      'Each item includes the last-message preview and computed flags ' +
      '(escalated = agent triggered a handoff). unreadCount is always 0 ' +
      '(read-tracking deferred to a later workstream).',
  })
  @ApiQuery({ name: 'state', required: false, enum: AI_STATES })
  @ApiQuery({
    name: 'assignedTo',
    required: false,
    example: 'agent@example.com',
  })
  @ApiQuery({ name: 'q', required: false, example: '123456' })
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({ name: 'sort', required: false, enum: CONVERSATION_SORT_KEYS })
  @ApiQuery({ name: 'orderBy', required: false, enum: ['asc', 'desc'] })
  @ApiOkResponse({
    description: 'Paginated conversation list.',
    type: ConversationListResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  list(
    @Query(new ZodValidationPipe(listConversationsQuerySchema))
    query: ListConversationsQuery,
  ) {
    return this.control.listConversations(query);
  }

  // ---------------------------------------------------------------------------
  // GET /admin/conversations/:id
  // ---------------------------------------------------------------------------

  @Get(':id')
  @ApiOperation({
    summary: 'Get a conversation thread (admin)',
    description:
      'Returns the full conversation header (ai_state, assignedTo, handoffReason, ' +
      'humanSummary, pausedUntil, createdAt) together with all messages in ' +
      'ascending order.',
  })
  @ApiOkResponse({
    description: 'Conversation with messages.',
    type: ConversationThreadDto,
  })
  @ApiNotFoundResponse({ description: 'No conversation exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  async getOne(@Param('id', ParseUUIDPipe) id: string) {
    const { conversation, messages } = await this.control.getThread(id);
    // Serialize dates to ISO strings for the HTTP response.
    return {
      conversation: {
        id: conversation.id,
        psid: conversation.psid,
        aiState: conversation.aiState,
        assignedTo: conversation.assignedTo ?? null,
        handoffReason: conversation.handoffReason ?? null,
        humanSummary: conversation.humanSummary ?? null,
        pausedUntil: conversation.pausedUntil
          ? conversation.pausedUntil.toISOString()
          : null,
        createdAt: conversation.createdAt.toISOString(),
        pinned: conversation.pinnedAt != null,
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content ?? null,
        imageUrl: m.imageUrl ?? null,
        // Extraction metadata (vision/eval/audio) — the thread UI reads
        // attributes.audio to render the voice-note badge + player.
        attributes: (m.attributes as Record<string, unknown> | null) ?? null,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // POST /admin/conversations/:id/reset
  // ---------------------------------------------------------------------------

  @Post(':id/reset')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reset a conversation (admin)',
    description:
      "Full wipe: clears the agent's memory (Mastra working memory + thread " +
      'message history) and the conversation context, then hard-deletes the ' +
      "conversation's messages so the thread shows empty. The conversation row, " +
      'its ai_state/assignment, and the audit-event log are preserved. ' +
      'Irreversible — the deleted messages cannot be recovered.',
  })
  @ApiOkResponse({
    description: 'Conversation reset. Returns { id, deletedMessages }.',
  })
  @ApiNotFoundResponse({ description: 'No conversation exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  reset(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { email: string },
  ) {
    return this.control.resetMemory(id, user.email);
  }

  // ---------------------------------------------------------------------------
  // POST /admin/conversations/:id/pause
  // ---------------------------------------------------------------------------

  @Post(':id/pause')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Pause the AI on a conversation',
    description:
      'Sets ai_state=paused and optionally records a handoffReason and a ' +
      'pausedUntil timestamp (durationMinutes ≤ 1440). The AI gate in ' +
      'AgentService enforces the paused state on all subsequent inbound turns.',
  })
  @ApiBody({
    schema: { example: { reason: 'Customer upset', durationMinutes: 60 } },
  })
  @ApiOkResponse({ description: 'Conversation paused.' })
  @ApiBadRequestResponse({ description: 'Validation failure.' })
  @ApiNotFoundResponse({ description: 'No conversation exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  pause(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(pauseConversationSchema))
    body: PauseConversationInput,
    @CurrentUser() user: { email: string },
  ) {
    return this.control.pause(id, user.email, body);
  }

  // ---------------------------------------------------------------------------
  // POST /admin/conversations/:id/resume
  // ---------------------------------------------------------------------------

  @Post(':id/resume')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resume the AI on a conversation',
    description:
      'Sets ai_state=bot and clears pausedUntil. An optional human summary is ' +
      'stored in humanSummary and injected into the agent on the next turn (WS7).',
  })
  @ApiBody({
    schema: {
      example: { summary: 'Customer agreed to size 2 for the white abaya.' },
    },
  })
  @ApiOkResponse({ description: 'Conversation resumed.' })
  @ApiNotFoundResponse({ description: 'No conversation exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  resume(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(resumeConversationSchema))
    body: ResumeConversationInput,
    @CurrentUser() user: { email: string },
  ) {
    return this.control.resume(id, user.email, body);
  }

  // ---------------------------------------------------------------------------
  // PATCH /admin/conversations/:id/assignment
  // ---------------------------------------------------------------------------

  @Patch(':id/assignment')
  @ApiOperation({
    summary: 'Assign (or unassign) a conversation to a human agent',
    description:
      'When assignedTo is non-null the conversation moves to ai_state=human. ' +
      'When assignedTo is null the field is cleared without changing ai_state.',
  })
  @ApiBody({ schema: { example: { assignedTo: 'agent@masafashion.com' } } })
  @ApiOkResponse({ description: 'Assignment updated.' })
  @ApiBadRequestResponse({ description: 'Validation failure.' })
  @ApiNotFoundResponse({ description: 'No conversation exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(assignConversationSchema))
    body: AssignConversationInput,
    @CurrentUser() user: { email: string },
  ) {
    return this.control.assign(id, user.email, body);
  }

  // ---------------------------------------------------------------------------
  // PATCH /admin/conversations/:id/pin
  // ---------------------------------------------------------------------------

  @Patch(':id/pin')
  @ApiOperation({
    summary: 'Pin or unpin a conversation in the admin inbox',
    description:
      'Sets (or clears) the inbox pin. Pinned conversations always sort first ' +
      'in GET /admin/conversations regardless of the sort key. A pure UI ' +
      'preference — ai_state is untouched and no audit event is recorded.',
  })
  @ApiBody({ schema: { example: { pinned: true } } })
  @ApiOkResponse({ description: 'Pin updated. Returns { id, pinned }.' })
  @ApiBadRequestResponse({ description: 'Validation failure.' })
  @ApiNotFoundResponse({ description: 'No conversation exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  pin(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(pinConversationSchema))
    body: PinConversationInput,
  ) {
    return this.control.setPinned(id, body.pinned);
  }

  // ---------------------------------------------------------------------------
  // DELETE /admin/conversations/:id
  // ---------------------------------------------------------------------------

  @Delete(':id')
  @Roles('admin')
  @ApiOperation({
    summary: 'Delete a conversation permanently (admin only)',
    description:
      'Hard-deletes the conversation row and clears the agent memory for the ' +
      'customer. Messages and audit events cascade; orders keep their rows ' +
      'with conversation_id nulled. Intended for cleaning up test threads. ' +
      'Irreversible.',
  })
  @ApiOkResponse({ description: 'Conversation deleted. Returns { id }.' })
  @ApiNotFoundResponse({ description: 'No conversation exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role (admin required).' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { email: string },
  ) {
    return this.control.deleteConversation(id, user.email);
  }

  // ---------------------------------------------------------------------------
  // POST /admin/conversations/:id/handoff
  // ---------------------------------------------------------------------------

  @Post(':id/handoff')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Hand off a conversation to a human agent (admin-initiated)',
    description:
      'Sets ai_state=human and optionally records a handoffReason. The bot-pause ' +
      'gate in AgentService silences the AI on all subsequent turns.',
  })
  @ApiBody({ schema: { example: { reason: 'Customer wants custom size' } } })
  @ApiOkResponse({ description: 'Conversation handed off.' })
  @ApiNotFoundResponse({ description: 'No conversation exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  handoff(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(handoffConversationSchema))
    body: HandoffConversationInput,
    @CurrentUser() user: { email: string },
  ) {
    return this.control.handoff(id, user.email, body);
  }

  // ---------------------------------------------------------------------------
  // POST /admin/conversations/:id/messages
  // ---------------------------------------------------------------------------

  @Post(':id/messages')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Send a human-agent message to the customer',
    description:
      'Inserts a role=human message and delivers it to the customer via Messenger — ' +
      'as a plain RESPONSE within 24h of the last customer message, or with the ' +
      'HUMAN_AGENT tag outside that window (requires the human_agent permission). ' +
      'The conversation must NOT be in ai_state=bot — pause or hand off first. ' +
      'Pass an Idempotency-Key header to make the call safe to retry; duplicate ' +
      'requests with the same key return the original message with delivered=false. ' +
      'A failed Messenger send is reported via delivered=false + deliveryError; ' +
      'the message row is persisted either way.',
  })
  @ApiCreatedResponse({
    description: 'Message sent (or duplicate acknowledged).',
  })
  @ApiBadRequestResponse({
    description: 'Validation failure or conversation is still in ai_state=bot.',
  })
  @ApiNotFoundResponse({ description: 'No conversation exists with that id.' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid bearer token.' })
  @ApiForbiddenResponse({ description: 'Insufficient role.' })
  sendMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(humanMessageSchema)) body: HumanMessageInput,
    @CurrentUser() user: { email: string },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.control.sendHumanMessage(id, user.email, body, idempotencyKey);
  }
}
