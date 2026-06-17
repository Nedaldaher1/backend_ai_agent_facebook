import { Inject, Injectable } from '@nestjs/common';
import { asc, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/core/database/drizzle';
import { normalizeListOptions, type ListOptions } from '@/common/types/query';
import {
  conversations,
  type Conversation,
  type NewConversation,
} from './entities/conversation.entity';
import {
  messages,
  type Message,
  type NewMessage,
} from './entities/message.entity';

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
}
