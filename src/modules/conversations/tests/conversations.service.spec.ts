import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConversationsService } from '../conversations.service';
import type { ConversationsRepository } from '../conversations.repository';
import { MESSAGE_ROLES } from '../entities/message.entity';

/** A real (v4) UUID — conversation_id is a uuid column, so the schema enforces format. */
const CONVERSATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const makeConversation = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  psid: 'psid-123',
  threadId: null,
  adRef: null,
  state: null,
  createdAt: new Date(),
  aiState: 'bot',
  assignedTo: null,
  handoffReason: null,
  humanSummary: null,
  pausedUntil: null,
  aiStateUpdatedAt: new Date(),
  ...overrides,
});

const makeMessage = (overrides: Record<string, unknown> = {}) => ({
  id: 'm1',
  conversationId: 'c1',
  role: 'customer',
  content: 'مرحبا، أريد أن أعرف المقاسات المتاحة',
  imageUrl: null,
  attributes: null,
  createdAt: new Date(),
  ...overrides,
});

describe('ConversationsService', () => {
  const listConversations = jest.fn();
  const findConversationById = jest.fn();
  const findConversationByPsid = jest.fn();
  const insertConversation = jest.fn();
  const updateConversationState = jest.fn();
  const listMessagesByConversation = jest.fn();
  const findMessageById = jest.fn();
  const insertMessage = jest.fn();

  const repo = {
    listConversations,
    findConversationById,
    findConversationByPsid,
    insertConversation,
    updateConversationState,
    listMessagesByConversation,
    findMessageById,
    insertMessage,
  } as unknown as ConversationsRepository;

  const service = new ConversationsService(repo);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- addMessage role validation ---

  it.each(MESSAGE_ROLES)(
    'addMessage succeeds for valid role "%s"',
    async (role) => {
      const message = makeMessage({ role });
      insertMessage.mockResolvedValue(message);

      const result = await service.addMessage({
        conversationId: CONVERSATION_ID,
        role,
        content: 'test',
      });

      expect(insertMessage).toHaveBeenCalled();
      expect(result.role).toBe(role);
    },
  );

  it('addMessage throws BadRequestException for an invalid role', () => {
    expect(() =>
      service.addMessage(
        // Intentionally invalid — cast to exercise runtime rejection.
        { conversationId: 'c1', role: 'bot', content: 'hello' } as unknown as Parameters<typeof service.addMessage>[0],
      ),
    ).toThrow(BadRequestException);
    expect(insertMessage).not.toHaveBeenCalled();
  });

  it('addMessage throws BadRequestException for an empty role string', () => {
    expect(() =>
      service.addMessage(
        // Intentionally invalid — cast to exercise runtime rejection.
        { conversationId: 'c1', role: '', content: 'hello' } as unknown as Parameters<typeof service.addMessage>[0],
      ),
    ).toThrow(BadRequestException);
  });

  // --- findOrCreateByPsid ---

  it('findOrCreateByPsid returns the existing conversation when found', async () => {
    const existing = makeConversation({ psid: 'psid-123' });
    findConversationByPsid.mockResolvedValue(existing);

    const result = await service.findOrCreateByPsid('psid-123');

    expect(findConversationByPsid).toHaveBeenCalledWith('psid-123');
    expect(insertConversation).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });

  it('findOrCreateByPsid inserts a new conversation when none exists', async () => {
    const newConversation = makeConversation({ psid: 'psid-new' });
    findConversationByPsid.mockResolvedValue(undefined);
    insertConversation.mockResolvedValue(newConversation);

    const result = await service.findOrCreateByPsid('psid-new', {
      threadId: 'thread-1',
      adRef: 'ad-summer',
    });

    expect(insertConversation).toHaveBeenCalledWith({
      psid: 'psid-new',
      threadId: 'thread-1',
      adRef: 'ad-summer',
    });
    expect(result).toBe(newConversation);
  });

  it('findOrCreateByPsid inserts with minimal input when no extra options given', async () => {
    findConversationByPsid.mockResolvedValue(undefined);
    const newConversation = makeConversation({ psid: 'psid-bare' });
    insertConversation.mockResolvedValue(newConversation);

    await service.findOrCreateByPsid('psid-bare');

    expect(insertConversation).toHaveBeenCalledWith({
      psid: 'psid-bare',
      threadId: undefined,
      adRef: undefined,
    });
  });

  // --- getById ---

  it('getById throws NotFoundException when the conversation does not exist', async () => {
    findConversationById.mockResolvedValue(undefined);

    await expect(service.getById('missing')).rejects.toThrow(NotFoundException);
  });

  it('getById returns the conversation when found', async () => {
    const conv = makeConversation({ id: 'c2' });
    findConversationById.mockResolvedValue(conv);

    const result = await service.getById('c2');

    expect(result).toBe(conv);
  });
});
