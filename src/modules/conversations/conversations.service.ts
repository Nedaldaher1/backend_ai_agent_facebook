import { Injectable, NotFoundException } from '@nestjs/common';
import type { ListOptions } from '@/common/types/query';
import {
  createConversationSchema,
  createMessageSchema,
  parseOrThrow,
  type CreateConversationInput,
  type CreateMessageInput,
} from '@/common/validation';
import { ConversationsRepository } from './conversations.repository';
import type { Conversation } from './entities/conversation.entity';
import type { Message } from './entities/message.entity';

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
}
