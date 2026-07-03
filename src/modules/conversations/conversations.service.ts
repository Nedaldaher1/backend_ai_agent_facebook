import { Injectable, NotFoundException } from '@nestjs/common';
import type { ListOptions } from '@/common/types/query';
import {
  createConversationSchema,
  createMessageSchema,
  parseOrThrow,
  type CreateConversationInput,
  type CreateMessageInput,
} from '@/common/validation';
import type {
  ConversationDashboardStats,
  ConversationListRow,
  ConversationSortKey,
} from './conversations.repository';
import { ConversationsRepository } from './conversations.repository';
import type { AiState } from './conversations.repository';
import type { Conversation } from './entities/conversation.entity';
import type { Message } from './entities/message.entity';
import type {
  ConversationEvent,
  NewConversationEvent,
} from './entities/conversation-event.entity';

/** Options when opening (or reusing) a thread for a psid. */
export interface FindOrCreateConversationInput {
  threadId?: string;
  adRef?: string;
}

/**
 * Conversation + message logic and context tracking. The agent module calls this
 * (never the repository) to persist threads, append messages, and carry state
 * across turns.
 */
@Injectable()
export class ConversationsService {
  constructor(private readonly repo: ConversationsRepository) {}

  // --- conversations ---

  list(opts?: ListOptions): Promise<Conversation[]> {
    return this.repo.listConversations(opts);
  }

  /** SQL-side dashboard aggregates (state counts + escalated total). */
  dashboardStats(): Promise<ConversationDashboardStats> {
    return this.repo.dashboardStats();
  }

  async getById(id: string): Promise<Conversation> {
    const row = await this.repo.findConversationById(id);
    if (!row) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }
    return row;
  }

  getByPsid(psid: string): Promise<Conversation | undefined> {
    return this.repo.findConversationByPsid(psid);
  }

  create(input: CreateConversationInput): Promise<Conversation> {
    const data = parseOrThrow(createConversationSchema, input);
    return this.repo.insertConversation(data);
  }

  /**
   * Return the existing thread for a psid, or open one. The agent calls this at
   * the start of every inbound message so a customer always maps to one thread.
   */
  async findOrCreateByPsid(
    psid: string,
    input: FindOrCreateConversationInput = {},
  ): Promise<Conversation> {
    const existing = await this.repo.findConversationByPsid(psid);
    if (existing) {
      return existing;
    }
    return this.create({
      psid,
      threadId: input.threadId,
      adRef: input.adRef,
    });
  }

  async updateState(id: string, state: unknown): Promise<Conversation> {
    const row = await this.repo.updateConversationState(id, state);
    if (!row) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }
    return row;
  }

  // --- messages ---

  listMessages(conversationId: string, opts?: ListOptions): Promise<Message[]> {
    return this.repo.listMessagesByConversation(conversationId, opts);
  }

  async getMessageById(id: string): Promise<Message> {
    const row = await this.repo.findMessageById(id);
    if (!row) {
      throw new NotFoundException(`Message ${id} not found`);
    }
    return row;
  }

  addMessage(input: CreateMessageInput): Promise<Message> {
    const data = parseOrThrow(createMessageSchema, input);
    return this.repo.insertMessage(data);
  }

  /**
   * Hard-delete all messages in a conversation (admin "reset conversation").
   * Returns the number of rows removed. Delegates to the repository.
   */
  deleteMessages(conversationId: string): Promise<number> {
    return this.repo.deleteMessagesByConversation(conversationId);
  }

  /** Whether an inbound message with this idempotency key was already logged. */
  findMessageByExternalId(
    conversationId: string,
    externalId: string,
  ): Promise<Message | undefined> {
    return this.repo.findMessageByExternalId(conversationId, externalId);
  }

  /**
   * When the customer last wrote in this conversation (undefined if never).
   * Used for the Messenger 24-hour standard-window check.
   */
  findLastCustomerMessageAt(
    conversationId: string,
  ): Promise<Date | undefined> {
    return this.repo.findLastCustomerMessageAt(conversationId);
  }

  /** Recent agent messages carrying an eval `attributes` payload. */
  listAgentEvalRows(limit?: number): Promise<Message[]> {
    return this.repo.listAgentEvalRows(limit);
  }

  /**
   * Mark a conversation as handed off to a human agent.
   *
   * Writes `ai_state = 'human'` and `handoff_reason` via the dedicated columns
   * (WS4 — AIA-34) and appends a `handoff` audit event to `conversation_events`.
   * The `state` jsonb is intentionally left unchanged — it still holds customer
   * preferences and funnel data; `ai_state` is the source of truth for handler
   * routing from this point on.
   *
   * @param conversationId  UUID of the conversation to escalate.
   * @param reason          Human-readable escalation note for the admin side.
   */
  async escalateToHuman(
    conversationId: string,
    reason: string,
  ): Promise<Conversation> {
    const convo = await this.repo.findConversationById(conversationId);
    if (!convo) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    const fromState = convo.aiState;

    const updated = await this.repo.setAiState(conversationId, {
      aiState: 'human',
      handoffReason: reason,
    });

    await this.repo.recordEvent({
      conversationId,
      type: 'handoff',
      actorType: 'agent',
      fromState,
      toState: 'human',
      reason,
    });

    // setAiState only returns undefined when the row was deleted between the
    // findConversationById check above and the UPDATE — treat as not-found.
    if (!updated) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }
    return updated;
  }

  // --- thin pass-throughs for WS5 and later workstreams ---

  /**
   * Update dedicated handler-state columns on a conversation. Delegates to the
   * repository; callers (e.g. the admin handoff API) should use this rather
   * than the repository directly so the data-access layer stays behind the
   * service boundary.
   */
  setAiState(
    id: string,
    patch: Parameters<ConversationsRepository['setAiState']>[1],
  ): Promise<Conversation | undefined> {
    return this.repo.setAiState(id, patch);
  }

  /** One-shot clear of the human handoff summary after it has been injected. */
  clearHumanSummary(id: string): Promise<Conversation | undefined> {
    return this.repo.setAiState(id, { humanSummary: null });
  }

  /**
   * Append an immutable audit event. Delegates to the repository; callers
   * should use this rather than the repository directly.
   */
  recordEvent(input: NewConversationEvent): Promise<ConversationEvent> {
    return this.repo.recordEvent(input);
  }

  /**
   * Paginated list of conversations with optional state/assignee/psid filters
   * and a last-message preview per row. Delegates entirely to the repository
   * so the ConversationControlService never touches the repo directly.
   */
  listWithPreview(
    filters: {
      aiState?: AiState;
      assignedTo?: string;
      q?: string;
      sort?: ConversationSortKey;
    } & ListOptions,
  ): Promise<{ items: ConversationListRow[]; total: number }> {
    return this.repo.listConversationsWithPreview(filters);
  }

  /**
   * Pin or unpin a conversation in the admin inbox. Delegates to the
   * repository. Returns undefined when the conversation does not exist.
   */
  setPinned(id: string, pinned: boolean): Promise<Conversation | undefined> {
    return this.repo.setPinned(id, pinned);
  }

  /**
   * Hard-delete a conversation (messages + audit events cascade; orders are
   * kept with conversation_id nulled). Returns true when a row was removed.
   */
  deleteConversation(id: string): Promise<boolean> {
    return this.repo.deleteConversationById(id);
  }

  /**
   * Persist first-touch ad-attribution on a conversation (WS3).
   * Delegates to the repository's atomic WHERE attributed_at IS NULL UPDATE.
   * Returns the updated row on the first write, undefined on subsequent calls
   * (already attributed — idempotent no-op).
   */
  recordFirstTouchAttribution(
    conversationId: string,
    attrib: Parameters<
      ConversationsRepository['recordFirstTouchAttribution']
    >[1],
  ): Promise<Conversation | undefined> {
    return this.repo.recordFirstTouchAttribution(conversationId, attrib);
  }

  /**
   * Atomically shallow-merge `patch` into the `state` jsonb column (WS3 — and
   * other callers). Delegates to the repository's `coalesce || patch` statement
   * so no read-modify-write is needed. Returns undefined when the row is gone.
   */
  mergeState(
    conversationId: string,
    patch: Record<string, unknown>,
  ): Promise<Conversation | undefined> {
    return this.repo.mergeConversationState(conversationId, patch);
  }
}
