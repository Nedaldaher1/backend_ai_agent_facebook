/**
 * ConversationControlService — admin-side handoff and conversation control.
 *
 * Lives in AgentModule (it imports ConversationsModule and provides MessengerClient,
 * so placing this service here avoids any new cross-module edge).
 *
 * Every state-mutating method follows the same pattern:
 *   1. Load via ConversationsService.getById (404 if missing).
 *   2. Capture fromState.
 *   3. setAiState via ConversationsService.
 *   4. recordEvent via ConversationsService.
 *
 * Human-message delivery (WS6) also passes through here so that idempotency,
 * gating, message persistence, and Messenger delivery are all co-located.
 * Messages are sent via MessengerClient.sendText(..., true) — the HUMAN_AGENT tag
 * allows out-of-window replies (within 7 days of the last customer message).
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  DEFAULT_LIST_LIMIT,
  type ListOptions,
  type PaginatedResult,
} from '@/common/types/query';
import { ConversationsService } from './conversations.service';
import type { AiState } from './conversations.repository';
import type { Conversation } from './entities/conversation.entity';
import type { Message } from './entities/message.entity';
import { MessengerClient } from '@/modules/agent/messenger/messenger.client';
import { AgentService } from '@/modules/agent/agent.service';
import type {
  AssignConversationInput,
  HandoffConversationInput,
  HumanMessageInput,
  ListConversationsQuery,
  PauseConversationInput,
  ResumeConversationInput,
} from './dto/conversation-control.dto';
import type { ConversationListItemDto } from './dto/conversation-control.dto';

/** 1-minute window for the human-message idempotency hash. */
const HUMAN_MSG_DEDUP_WINDOW_MS = 60_000;

/**
 * Compute a dedup key for a human-sent message from the admin panel.
 * Mirrors the pattern from AgentService.computeDedupKey but uses a 60-second
 * window (admin sends are deliberate, not rapid double-taps) and a `h:` prefix
 * to separate the namespace from customer-inbound keys.
 */
function computeHumanMsgKey(conversationId: string, text: string): string {
  const normalizedText = text.trim().replace(/\s+/g, ' ').toLowerCase();
  const window = Math.floor(Date.now() / HUMAN_MSG_DEDUP_WINDOW_MS);
  const digest = createHash('sha256')
    .update(`${conversationId}|${normalizedText}|${window}`)
    .digest('hex')
    .slice(0, 40);
  return `h:${digest}`;
}

@Injectable()
export class ConversationControlService {
  private readonly logger = new Logger(ConversationControlService.name);

  constructor(
    private readonly conversations: ConversationsService,
    private readonly messengerClient: MessengerClient,
    private readonly agent: AgentService,
  ) {}

  // ---------------------------------------------------------------------------
  // List / read
  // ---------------------------------------------------------------------------

  /**
   * Returns a paginated list of conversations with last-message preview and
   * computed flags. Maps the repository row shape to the admin DTO shape.
   */
  async listConversations(
    filters: ListConversationsQuery,
  ): Promise<PaginatedResult<ConversationListItemDto>> {
    const limit = filters.limit ?? DEFAULT_LIST_LIMIT;
    const offset = filters.offset ?? 0;

    const { items, total } = await this.conversations.listWithPreview({
      aiState: filters.state as AiState | undefined,
      assignedTo: filters.assignedTo,
      q: filters.q,
      limit,
      offset,
      orderBy: filters.orderBy,
    });

    const dtoItems: ConversationListItemDto[] = items.map((row) => ({
      id: row.id,
      customer: row.psid,
      aiState: row.aiState as AiState,
      assignedTo: row.assignedTo ?? null,
      handoffReason: row.handoffReason ?? null,
      lastMessagePreview: row.lastMessagePreview ?? null,
      lastMessageAt: row.lastMessageAt
        ? row.lastMessageAt.toISOString()
        : null,
      unreadCount: 0, // deferred — no read tracking yet (WS8)
      escalated: row.handoffReason != null,
    }));

    return { items: dtoItems, total, limit, offset };
  }

  /**
   * Returns the full conversation header plus its message thread (ascending).
   * 404 when the conversation does not exist.
   */
  async getThread(id: string): Promise<{
    conversation: Conversation;
    messages: Message[];
  }> {
    const conversation = await this.conversations.getById(id);
    const msgs = await this.conversations.listMessages(id, { orderBy: 'asc' });
    return { conversation, messages: msgs };
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  /**
   * Admin "reset conversation" — full wipe. In order:
   *  1. Clears the agent's Mastra memory for this customer (resource-scoped
   *     working memory + the thread's message history) via AgentService.
   *  2. Clears the conversation `state` jsonb (last product, prefs, ad product…).
   *  3. Hard-deletes the conversation's messages (public.messages) so the thread
   *     shows empty in the admin panel (the admin explicitly chose a full wipe).
   *  4. Records a `reset` audit event.
   *
   * The conversation row, its ai_state/assignment, and the append-only event log
   * are preserved. 404 when the conversation does not exist. Returns the number
   * of message rows removed.
   */
  async resetMemory(
    id: string,
    actor: string,
  ): Promise<{ id: string; deletedMessages: number }> {
    const convo = await this.conversations.getById(id);

    // 1. Wipe Mastra memory (working memory + thread/message history).
    await this.agent.resetConversationMemory(convo.psid);

    // 2. Clear the conversation context jsonb.
    await this.conversations.updateState(id, {});

    // 3. Hard-delete the visible message log.
    const deletedMessages = await this.conversations.deleteMessages(id);

    // 4. Audit trail (kept — not part of the wipe). ai_state is unchanged, so
    //    fromState === toState; the event documents who reset and when.
    await this.conversations.recordEvent({
      conversationId: id,
      type: 'reset',
      actor,
      actorType: 'admin',
      fromState: convo.aiState as AiState,
      toState: convo.aiState as AiState,
      reason: 'conversation reset (memory + messages cleared)',
      metadata: { deletedMessages },
    });

    return { id, deletedMessages };
  }

  // ---------------------------------------------------------------------------
  // State mutations
  // ---------------------------------------------------------------------------

  /**
   * Pause the AI on this conversation. Sets ai_state=paused and records
   * the event. The Messenger transport's ai_state column is the source of
   * truth — no external call is needed.
   */
  async pause(
    id: string,
    actor: string,
    input: PauseConversationInput,
  ): Promise<Conversation> {
    const convo = await this.conversations.getById(id);
    if (!convo) throw new NotFoundException(`Conversation ${id} not found`);
    const fromState = convo.aiState as AiState;

    const pausedUntil = input.durationMinutes
      ? new Date(Date.now() + input.durationMinutes * 60_000)
      : null;

    const updated = await this.conversations.setAiState(id, {
      aiState: 'paused',
      // Only overwrite handoffReason when a reason is supplied — a bare pause
      // must not wipe an existing escalation reason.
      ...(input.reason ? { handoffReason: input.reason } : {}),
      pausedUntil,
    });
    if (!updated) throw new NotFoundException(`Conversation ${id} not found`);

    await this.conversations.recordEvent({
      conversationId: id,
      type: 'pause',
      actor,
      actorType: 'admin',
      fromState,
      toState: 'paused',
      reason: input.reason,
      metadata: input.durationMinutes
        ? { durationMinutes: input.durationMinutes }
        : null,
    });

    return updated;
  }

  /**
   * Resume the AI on this conversation. Sets ai_state=bot, clears pausedUntil,
   * optionally stores a humanSummary for injection on the next turn (WS7).
   */
  async resume(
    id: string,
    actor: string,
    input: ResumeConversationInput,
  ): Promise<Conversation> {
    const convo = await this.conversations.getById(id);
    if (!convo) throw new NotFoundException(`Conversation ${id} not found`);
    const fromState = convo.aiState as AiState;

    const updated = await this.conversations.setAiState(id, {
      aiState: 'bot',
      pausedUntil: null,
      ...(input.summary ? { humanSummary: input.summary } : {}),
    });
    if (!updated) throw new NotFoundException(`Conversation ${id} not found`);

    await this.conversations.recordEvent({
      conversationId: id,
      type: 'resume',
      actor,
      actorType: 'admin',
      fromState,
      toState: 'bot',
    });

    return updated;
  }

  /**
   * Assign (or unassign) the conversation.
   *
   * - If assignedTo is non-null: flip ai_state to 'human' and set assignedTo.
   * - If assignedTo is null: clear the field only (ai_state stays unchanged).
   */
  async assign(
    id: string,
    actor: string,
    input: AssignConversationInput,
  ): Promise<Conversation> {
    const convo = await this.conversations.getById(id);
    if (!convo) throw new NotFoundException(`Conversation ${id} not found`);
    const fromState = convo.aiState as AiState;

    let updated: Conversation | undefined;

    if (input.assignedTo !== null) {
      updated = await this.conversations.setAiState(id, {
        aiState: 'human',
        assignedTo: input.assignedTo,
      });
      if (!updated) throw new NotFoundException(`Conversation ${id} not found`);

      await this.conversations.recordEvent({
        conversationId: id,
        type: 'assign',
        actor,
        actorType: 'admin',
        fromState,
        toState: 'human',
        metadata: { assignedTo: input.assignedTo },
      });
    } else {
      updated = await this.conversations.setAiState(id, {
        assignedTo: null,
      });
      if (!updated) throw new NotFoundException(`Conversation ${id} not found`);

      await this.conversations.recordEvent({
        conversationId: id,
        type: 'assign',
        actor,
        actorType: 'admin',
        fromState,
        toState: fromState, // state unchanged on unassign
        metadata: { assignedTo: null },
      });
    }

    return updated;
  }

  /**
   * Escalate the conversation to a human agent (admin-initiated handoff).
   * Sets ai_state=human and records the handoff event.
   */
  async handoff(
    id: string,
    actor: string,
    input: HandoffConversationInput,
  ): Promise<Conversation> {
    const convo = await this.conversations.getById(id);
    if (!convo) throw new NotFoundException(`Conversation ${id} not found`);
    const fromState = convo.aiState as AiState;

    const updated = await this.conversations.setAiState(id, {
      aiState: 'human',
      handoffReason: input.reason ?? null,
    });
    if (!updated) throw new NotFoundException(`Conversation ${id} not found`);

    await this.conversations.recordEvent({
      conversationId: id,
      type: 'handoff',
      actor,
      actorType: 'admin',
      fromState,
      toState: 'human',
      reason: input.reason,
    });

    return updated;
  }

  // ---------------------------------------------------------------------------
  // WS6 — human-agent message delivery
  // ---------------------------------------------------------------------------

  /**
   * Send a human-agent message to the customer via Messenger (HUMAN_AGENT tag).
   *
   * Gate: the conversation must NOT be in ai_state='bot'. If the AI is active,
   * the admin must pause or hand off first.
   *
   * Idempotency: a provided `idempotencyKey` (or a computed hash of the text
   * within a 1-minute window) short-circuits duplicates — the message is NOT
   * re-inserted or re-sent. Returns `delivered: false` on idempotent no-op.
   *
   * Delivery: MessengerClient.sendText(psid, text, true) sends with the
   * HUMAN_AGENT message tag which allows out-of-window replies within 7 days
   * of the last customer message. sendText throws MessengerSendError on any
   * non-2xx Graph API response; the error is caught here and mapped to
   * delivered=false so the message row is always persisted even on send failure.
   */
  async sendHumanMessage(
    id: string,
    actor: string,
    input: HumanMessageInput,
    idempotencyKey?: string,
  ): Promise<{ message: Message; delivered: boolean }> {
    const convo = await this.conversations.getById(id);

    if (convo.aiState === 'bot') {
      throw new BadRequestException(
        'Cannot send a human message while the AI is active (ai_state=bot). ' +
          'Pause or hand off the conversation first.',
      );
    }

    // Idempotency key: caller-supplied or derived from content + time window.
    const externalId =
      idempotencyKey ?? computeHumanMsgKey(convo.id, input.text);

    const existing = await this.conversations.findMessageByExternalId(
      convo.id,
      externalId,
    );
    if (existing) {
      // Idempotent no-op — return the existing message, do not re-deliver.
      return { message: existing, delivered: false };
    }

    // Persist the message first so it is never lost even if Messenger is down.
    const msg = await this.conversations.addMessage({
      conversationId: convo.id,
      role: 'human',
      content: input.text,
      externalId,
    });

    // Deliver via Messenger Send API with HUMAN_AGENT tag (humanAgent=true).
    // sendText throws MessengerSendError on non-2xx; catch and map to delivered=false.
    let delivered = false;
    try {
      await this.messengerClient.sendText(convo.psid, input.text, true);
      delivered = true;
    } catch (err) {
      this.logger.warn(
        `Human-agent message send failed for conversation ${convo.id} (PSID ${convo.psid}): ${String(err)}`,
      );
    }

    await this.conversations.recordEvent({
      conversationId: convo.id,
      type: 'human_message',
      actor,
      actorType: 'admin',
      metadata: { messageId: msg.id, delivered },
    });

    return { message: msg, delivered };
  }
}
