import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConversationsService } from '../conversations.service';
import type { ConversationsRepository } from '../conversations.repository';
import type { EscalationNotifier } from '@/modules/notifications/escalation-notifier';
import { MESSAGE_ROLES } from '../entities/message.entity';

/** Flush the fire-and-forget notification promise chain. */
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

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
  const setAiState = jest.fn();
  const recordEvent = jest.fn();

  const repo = {
    listConversations,
    findConversationById,
    findConversationByPsid,
    insertConversation,
    updateConversationState,
    listMessagesByConversation,
    findMessageById,
    insertMessage,
    setAiState,
    recordEvent,
  } as unknown as ConversationsRepository;

  const notifyMock = jest.fn().mockResolvedValue(undefined);
  const notifier = { notify: notifyMock } as unknown as EscalationNotifier;

  const service = new ConversationsService(repo, notifier);

  beforeEach(() => {
    jest.clearAllMocks();
    notifyMock.mockResolvedValue(undefined);
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
        {
          conversationId: 'c1',
          role: 'bot',
          content: 'hello',
        } as unknown as Parameters<typeof service.addMessage>[0],
      ),
    ).toThrow(BadRequestException);
    expect(insertMessage).not.toHaveBeenCalled();
  });

  it('addMessage throws BadRequestException for an empty role string', () => {
    expect(() =>
      service.addMessage(
        // Intentionally invalid — cast to exercise runtime rejection.
        {
          conversationId: 'c1',
          role: '',
          content: 'hello',
        } as unknown as Parameters<typeof service.addMessage>[0],
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

  // --- escalateToHuman (WS4 — AIA-34) ---

  it('escalateToHuman throws NotFoundException when conversation is not found', async () => {
    findConversationById.mockResolvedValue(undefined);

    await expect(
      service.escalateToHuman(CONVERSATION_ID, 'test reason'),
    ).rejects.toThrow(NotFoundException);

    expect(setAiState).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('escalateToHuman calls setAiState with aiState human and the reason', async () => {
    const convo = makeConversation({ id: CONVERSATION_ID, aiState: 'bot' });
    const updated = makeConversation({
      id: CONVERSATION_ID,
      aiState: 'human',
      handoffReason: 'too complex',
    });
    findConversationById.mockResolvedValue(convo);
    setAiState.mockResolvedValue(updated);
    recordEvent.mockResolvedValue({});

    const result = await service.escalateToHuman(
      CONVERSATION_ID,
      'too complex',
    );

    expect(setAiState).toHaveBeenCalledWith(CONVERSATION_ID, {
      aiState: 'human',
      handoffReason: 'too complex',
    });
    expect(result).toBe(updated);
  });

  it('escalateToHuman records a handoff audit event with correct fields', async () => {
    const convo = makeConversation({ id: CONVERSATION_ID, aiState: 'bot' });
    const updated = makeConversation({ id: CONVERSATION_ID, aiState: 'human' });
    findConversationById.mockResolvedValue(convo);
    setAiState.mockResolvedValue(updated);
    recordEvent.mockResolvedValue({});

    await service.escalateToHuman(CONVERSATION_ID, 'size question');

    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        type: 'handoff',
        actorType: 'agent',
        fromState: 'bot',
        toState: 'human',
        reason: 'size question',
      }),
    );
  });

  it('escalateToHuman fires the staff notification with conversation id, psid and reason', async () => {
    const convo = makeConversation({ id: CONVERSATION_ID, psid: 'psid-123' });
    const updated = makeConversation({ id: CONVERSATION_ID, aiState: 'human' });
    findConversationById.mockResolvedValue(convo);
    setAiState.mockResolvedValue(updated);
    recordEvent.mockResolvedValue({});

    await service.escalateToHuman(CONVERSATION_ID, 'size question');
    await flushMicrotasks();

    expect(notifyMock).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      psid: 'psid-123',
      reason: 'size question',
    });
  });

  it('escalateToHuman succeeds even when the notification rejects (fire-and-forget)', async () => {
    const convo = makeConversation({ id: CONVERSATION_ID });
    const updated = makeConversation({ id: CONVERSATION_ID, aiState: 'human' });
    findConversationById.mockResolvedValue(convo);
    setAiState.mockResolvedValue(updated);
    recordEvent.mockResolvedValue({});
    notifyMock.mockRejectedValue(new Error('telegram down'));

    const result = await service.escalateToHuman(CONVERSATION_ID, 'reason');
    // The rejected notify must be swallowed, not become an unhandled rejection.
    await flushMicrotasks();

    expect(result).toBe(updated);
  });

  it('escalateToHuman never notifies when the conversation is not found', async () => {
    findConversationById.mockResolvedValue(undefined);

    await expect(
      service.escalateToHuman(CONVERSATION_ID, 'reason'),
    ).rejects.toThrow(NotFoundException);
    await flushMicrotasks();

    expect(notifyMock).not.toHaveBeenCalled();
  });
});
