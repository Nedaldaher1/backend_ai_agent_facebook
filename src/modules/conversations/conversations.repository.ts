import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { normalizeListOptions, type ListOptions } from '@/common/types/query';
import {
  conversations,
  AI_STATES,
  type Conversation,
  type NewConversation,
} from './entities/conversation.entity';
import {
  messages,
  type Message,
  type NewMessage,
} from './entities/message.entity';
import {
  conversationEvents,
  type ConversationEvent,
  type NewConversationEvent,
} from './entities/conversation-event.entity';

/** Derived union from the AI_STATES tuple; avoids re-declaring the enum. */
export type AiState = (typeof AI_STATES)[number];

/**
 * Shape returned by listConversationsWithPreview: the key conversation columns
 * plus the most-recent message content and its timestamp (null when the
 * conversation has no messages yet).
 */
export interface ConversationListRow {
  id: string;
  psid: string;
  aiState: string;
  assignedTo: string | null;
  handoffReason: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: Date | null;
}

/**
 * Sole owner of conversations + messages SQL (the two runtime tables the agent
 * writes per thread). Query-builder only; `state` and `attributes` are free-form
 * jsonb handed through unchanged.
 */
@Injectable()
export class ConversationsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  // --- conversations ---

  async listConversations(opts: ListOptions = {}): Promise<Conversation[]> {
    const { limit, offset, orderBy } = normalizeListOptions(opts);
    const direction = orderBy === 'asc' ? asc : desc;
    return this.db
      .select()
      .from(conversations)
      .orderBy(direction(conversations.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async findConversationById(id: string): Promise<Conversation | undefined> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    return row;
  }

  /** Look up the thread for a page-scoped id (psid); most recent if duplicated. */
  async findConversationByPsid(
    psid: string,
  ): Promise<Conversation | undefined> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.psid, psid))
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    return row;
  }

  async insertConversation(input: NewConversation): Promise<Conversation> {
    const [row] = await this.db.insert(conversations).values(input).returning();
    return row;
  }

  async updateConversationState(
    id: string,
    state: unknown,
  ): Promise<Conversation | undefined> {
    const [row] = await this.db
      .update(conversations)
      .set({ state })
      .where(eq(conversations.id, id))
      .returning();
    return row;
  }

  /**
   * Atomically shallow-merge `patch` into the `state` jsonb in a single
   * statement (no read-modify-write): `||` overwrites the keys present in
   * `patch` and preserves the rest; coalesce handles a NULL column. Returns
   * undefined if the row does not exist.
   */
  async mergeConversationState(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Conversation | undefined> {
    const [row] = await this.db
      .update(conversations)
      .set({
        state: sql`coalesce(${conversations.state}, '{}'::jsonb) || ${JSON.stringify(
          patch,
        )}::jsonb`,
      })
      .where(eq(conversations.id, id))
      .returning();
    return row;
  }

  // --- messages ---

  async listMessagesByConversation(
    conversationId: string,
    opts: ListOptions = {},
  ): Promise<Message[]> {
    const { limit, offset, orderBy } = normalizeListOptions(opts);
    const direction = orderBy === 'asc' ? asc : desc;
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(direction(messages.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async findMessageById(id: string): Promise<Message | undefined> {
    const [row] = await this.db
      .select()
      .from(messages)
      .where(eq(messages.id, id))
      .limit(1);
    return row;
  }

  async insertMessage(input: NewMessage): Promise<Message> {
    const [row] = await this.db.insert(messages).values(input).returning();
    return row;
  }

  /**
   * Hard-delete every message belonging to a conversation (admin "reset
   * conversation"). Returns the number of rows removed. The conversation row
   * itself and its append-only audit events are left intact.
   */
  async deleteMessagesByConversation(conversationId: string): Promise<number> {
    const deleted = await this.db
      .delete(messages)
      .where(eq(messages.conversationId, conversationId))
      .returning({ id: messages.id });
    return deleted.length;
  }

  /**
   * Find an inbound message previously logged under this idempotency key, scoped
   * to the conversation. Backs the dedup short-circuit in AgentService.
   */
  async findMessageByExternalId(
    conversationId: string,
    externalId: string,
  ): Promise<Message | undefined> {
    const [row] = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.externalId, externalId),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * Recent agent messages that carry an `attributes` payload (the eval rows the
   * agent writes per product turn). Source for the descriptive eval report.
   */
  async listAgentEvalRows(limit = 500): Promise<Message[]> {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.role, 'agent'), isNotNull(messages.attributes)))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
  }

  // --- WS3 — first-touch ad-attribution ---

  /**
   * Attribution payload carried from the Messenger referral event (WS3).
   * All fields are optional — only those present on the event are set.
   */
  // (defined inline where used; extracted here for the return type below)

  /**
   * Write first-touch attribution in a single atomic UPDATE.
   *
   * The WHERE clause includes `attributed_at IS NULL` so this is idempotent:
   * only the first call that wins the race sets the attribution; subsequent
   * calls for the same conversation row silently no-op (0 rows updated → returns
   * undefined). This guarantees "set once, never overwritten" semantics without
   * a separate SELECT before the UPDATE.
   *
   * @param conversationId  UUID of the conversation to attribute.
   * @param attrib          Partial attribution data (only keys present are set).
   * @returns               The updated row (first touch written) or undefined (already attributed).
   */
  async recordFirstTouchAttribution(
    conversationId: string,
    attrib: {
      adId?: string;
      adRef?: string;
      adSource?: string;
      adProductId?: string;
      adContext?: unknown;
    },
  ): Promise<Conversation | undefined> {
    const set: Partial<typeof conversations.$inferInsert> = {
      attributedAt: new Date(),
    };
    if (attrib.adId !== undefined) set.adId = attrib.adId;
    if (attrib.adRef !== undefined) set.adRef = attrib.adRef;
    if (attrib.adSource !== undefined) set.adSource = attrib.adSource;
    if (attrib.adProductId !== undefined) set.adProductId = attrib.adProductId;
    if (attrib.adContext !== undefined) set.adContext = attrib.adContext;

    const [row] = await this.db
      .update(conversations)
      .set(set)
      .where(
        and(
          eq(conversations.id, conversationId),
          isNull(conversations.attributedAt),
        ),
      )
      .returning();
    return row; // undefined when already attributed (0 rows updated)
  }

  // --- conversation state (WS4 — AIA-34) ---

  /**
   * Update the dedicated handler-state columns on a conversation row.
   * Whenever `patch.aiState` is present, `ai_state_updated_at` is also set to
   * the current timestamp so callers can track when the transition happened.
   * Returns the updated row, or undefined if the conversation does not exist.
   */
  async setAiState(
    id: string,
    patch: {
      aiState?: AiState;
      assignedTo?: string | null;
      handoffReason?: string | null;
      humanSummary?: string | null;
      pausedUntil?: Date | null;
    },
  ): Promise<Conversation | undefined> {
    const updates: Partial<typeof conversations.$inferInsert> = { ...patch };
    if (patch.aiState !== undefined) {
      updates.aiStateUpdatedAt = new Date();
    }
    const [row] = await this.db
      .update(conversations)
      .set(updates)
      .where(eq(conversations.id, id))
      .returning();
    return row;
  }

  /**
   * Append an immutable audit event to the conversation_events table.
   * Returns the inserted row.
   */
  async recordEvent(
    input: NewConversationEvent,
  ): Promise<ConversationEvent> {
    const [row] = await this.db
      .insert(conversationEvents)
      .values(input)
      .returning();
    return row;
  }

  // --- WS5 — conversation list with last-message preview ---

  /**
   * Paginated list of conversations with optional filters and a correlated
   * subquery that fetches the most-recent message (content + created_at) per
   * conversation without a JOIN-then-GROUP-BY that would de-duplicate rows.
   *
   * All filtering (aiState, assignedTo, ILIKE psid search) is applied to both
   * the data page and the count query so totals stay consistent.
   */
  async listConversationsWithPreview(
    filters: {
      aiState?: AiState;
      assignedTo?: string;
      q?: string;
    } & ListOptions,
  ): Promise<{ items: ConversationListRow[]; total: number }> {
    const { limit, offset, orderBy } = normalizeListOptions(filters);
    const direction = orderBy === 'asc' ? asc : desc;

    // Build the WHERE conditions array incrementally.
    const conditions: SQL[] = [];
    if (filters.aiState !== undefined) {
      conditions.push(eq(conversations.aiState, filters.aiState));
    }
    if (filters.assignedTo !== undefined) {
      conditions.push(eq(conversations.assignedTo, filters.assignedTo));
    }
    if (filters.q !== undefined) {
      conditions.push(ilike(conversations.psid, `%${filters.q}%`));
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // Correlated subquery columns via sql`` so Drizzle doesn't need a lateral
    // join helper — this keeps the query builder typed and avoids raw SQL strings.
    //
    // A bare column embedded in a sql`` template (e.g. ${conversations.id}) renders
    // UNQUALIFIED as "id". Inside these subqueries that "id" binds to the inner
    // messages.id (nearest scope), so the correlation becomes m.conversation_id =
    // m.id and the preview is always null. Qualify the outer column explicitly so it
    // binds to conversations.id.
    const convoId = sql`${sql.identifier('conversations')}.${sql.identifier('id')}`;
    const lastContent = sql<string | null>`(
      SELECT content FROM messages m
      WHERE m.conversation_id = ${convoId}
      ORDER BY m.created_at DESC
      LIMIT 1
    )`;
    // A raw sql`` expression carries no Drizzle column mapper, so the
    // node-postgres driver hands this timestamp back as a *string* (the raw
    // Postgres text, e.g. "2026-06-23 08:20:26.338+03") rather than a Date —
    // unlike a mapped entity column. Type it honestly as string and convert to
    // a Date below so the ConversationListRow contract (Date | null) holds.
    const lastCreatedAt = sql<string | null>`(
      SELECT created_at FROM messages m
      WHERE m.conversation_id = ${convoId}
      ORDER BY m.created_at DESC
      LIMIT 1
    )`;

    const rows = await this.db
      .select({
        id: conversations.id,
        psid: conversations.psid,
        aiState: conversations.aiState,
        assignedTo: conversations.assignedTo,
        handoffReason: conversations.handoffReason,
        lastMessagePreview: lastContent,
        lastMessageAt: lastCreatedAt,
      })
      .from(conversations)
      .where(where)
      .orderBy(direction(conversations.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(conversations)
      .where(where);

    // Normalize the raw timestamp string into a Date (see lastCreatedAt note).
    // new Date() accepts a string or a Date, so this stays correct even if a
    // driver/version returns the column already parsed.
    const items: ConversationListRow[] = rows.map((row) => ({
      ...row,
      lastMessageAt:
        row.lastMessageAt != null ? new Date(row.lastMessageAt) : null,
    }));

    return { items, total: Number(total) };
  }
}
