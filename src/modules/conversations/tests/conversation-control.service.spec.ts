/**
 * Unit tests for ConversationControlService (WS5 + WS6 — AIA-34).
 *
 * ConversationsService and MessengerClient are fully mocked.
 * No database or network calls are made.
 *
 * Coverage:
 *  - pause:  setAiState called with correct patch, event recorded.
 *  - resume: same pattern; humanSummary included iff input.summary present.
 *  - assign: non-null → aiState='human'; null → state unchanged, no change.
 *  - handoff: aiState='human', event 'handoff'.
 *  - sendHumanMessage: gate (ai_state=bot throws), idempotency, happy path,
 *             addMessage before sendText (persist-first ordering),
 *             sendText(psid, text, true) called with humanAgent=true,
 *             success → delivered=true, MessengerSendError → delivered=false,
 *             recordEvent always called with correct metadata.
 *  - getThread: returns {conversation, messages}.
 *  - listConversations: maps rows, escalated flag, unreadCount:0, ISO dates.
 */

// flydrive is ESM-only; stub it so the import chain doesn't try to require the
// real module under Jest (CJS).
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));

// conversation-control.service imports AgentService (a DI value) for the reset
// path; AgentService transitively pulls in mastra.factory + @mastra/core
// (ESM-only, not requirable under Jest CJS). Stub the factory and the @mastra
// entrypoints so the module graph loads. AgentService is mocked per test.
jest.mock('@/modules/agent/mastra/mastra.factory', () => ({
  buildMastra: jest.fn(),
}));
jest.mock('@mastra/core/agent', () => ({ Agent: jest.fn() }));
jest.mock('@mastra/core/di', () => ({ RequestContext: jest.fn() }));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConversationControlService } from '../conversation-control.service';
import type { ConversationsService } from '../conversations.service';
import type { MessengerClient } from '@/modules/agent/messenger/messenger.client';
import type { AgentService } from '@/modules/agent/agent.service';
import type { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONV_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const PSID = 'psid-test-001';
const ACTOR = 'admin@masafashion.com';

function makeConvo(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: CONV_ID,
    psid: PSID,
    threadId: null,
    adRef: null,
    state: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    aiState: 'bot',
    assignedTo: null,
    handoffReason: null,
    humanSummary: null,
    pausedUntil: null,
    aiStateUpdatedAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: 'msg-001',
    conversationId: CONV_ID,
    role: 'human',
    content: 'مرحبا',
    imageUrl: null,
    attributes: null,
    externalId: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMocks() {
  const getById = jest.fn();
  const setAiState = jest.fn();
  const recordEvent = jest.fn();
  const addMessage = jest.fn();
  const findMessageByExternalId = jest.fn();
  const listMessages = jest.fn();
  const listWithPreview = jest.fn();
  const updateState = jest.fn();
  const deleteMessages = jest.fn();

  const conversations = {
    getById,
    setAiState,
    recordEvent,
    addMessage,
    findMessageByExternalId,
    listMessages,
    listWithPreview,
    updateState,
    deleteMessages,
  } as unknown as ConversationsService;

  const sendText = jest.fn().mockResolvedValue(undefined);
  const messengerClient = { sendText } as unknown as MessengerClient;

  const resetConversationMemory = jest.fn().mockResolvedValue(undefined);
  const agent = { resetConversationMemory } as unknown as AgentService;

  const svc = new ConversationControlService(
    conversations,
    messengerClient,
    agent,
  );

  return { svc, getById, setAiState, recordEvent, addMessage, findMessageByExternalId, listMessages, listWithPreview, sendText, updateState, deleteMessages, resetConversationMemory };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConversationControlService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // resetMemory
  // -------------------------------------------------------------------------

  describe('resetMemory', () => {
    it('wipes Mastra memory, clears state, deletes messages, and records a reset event', async () => {
      const {
        svc,
        getById,
        updateState,
        deleteMessages,
        recordEvent,
        resetConversationMemory,
      } = makeMocks();
      const convo = makeConvo({ aiState: 'bot' });
      getById.mockResolvedValue(convo);
      updateState.mockResolvedValue(convo);
      deleteMessages.mockResolvedValue(5);
      recordEvent.mockResolvedValue({});

      const result = await svc.resetMemory(CONV_ID, ACTOR);

      // Mastra memory wiped for the conversation's customer (psid).
      expect(resetConversationMemory).toHaveBeenCalledWith(PSID);
      // Conversation context jsonb cleared.
      expect(updateState).toHaveBeenCalledWith(CONV_ID, {});
      // Visible message log hard-deleted.
      expect(deleteMessages).toHaveBeenCalledWith(CONV_ID);
      // Audit event recorded with the deleted count.
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: CONV_ID,
          type: 'reset',
          actor: ACTOR,
          actorType: 'admin',
          metadata: { deletedMessages: 5 },
        }),
      );
      expect(result).toEqual({ id: CONV_ID, deletedMessages: 5 });
    });

    it('aborts cleanly when the Mastra memory wipe fails (no half-done reset)', async () => {
      const {
        svc,
        getById,
        resetConversationMemory,
        updateState,
        deleteMessages,
        recordEvent,
      } = makeMocks();
      getById.mockResolvedValue(makeConvo({ aiState: 'bot' }));
      resetConversationMemory.mockRejectedValue(
        new Error('reset: Mastra memory wipe failed for psid'),
      );

      await expect(svc.resetMemory(CONV_ID, ACTOR)).rejects.toThrow(
        /memory wipe failed/i,
      );
      // The Mastra wipe runs FIRST, so a failure leaves everything else intact —
      // no state clear, no message delete, no audit event. The admin can retry.
      expect(updateState).not.toHaveBeenCalled();
      expect(deleteMessages).not.toHaveBeenCalled();
      expect(recordEvent).not.toHaveBeenCalled();
    });

    it('throws NotFound and performs no wipe when the conversation is missing', async () => {
      const { svc, getById, resetConversationMemory, deleteMessages } =
        makeMocks();
      getById.mockRejectedValue(new NotFoundException('nope'));

      await expect(svc.resetMemory(CONV_ID, ACTOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(resetConversationMemory).not.toHaveBeenCalled();
      expect(deleteMessages).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // pause
  // -------------------------------------------------------------------------

  describe('pause', () => {
    it('calls setAiState with aiState=paused, handoffReason, and computed pausedUntil', async () => {
      const { svc, getById, setAiState, recordEvent } = makeMocks();
      const convo = makeConvo({ aiState: 'bot' });
      const updated = makeConvo({ aiState: 'paused' });
      getById.mockResolvedValue(convo);
      setAiState.mockResolvedValue(updated);
      recordEvent.mockResolvedValue({});

      const before = Date.now();
      await svc.pause(CONV_ID, ACTOR, { reason: 'Customer upset', durationMinutes: 60 });
      const after = Date.now();

      expect(setAiState).toHaveBeenCalledWith(
        CONV_ID,
        expect.objectContaining({
          aiState: 'paused',
          handoffReason: 'Customer upset',
        }),
      );

      // pausedUntil must be ~now+60m
      const patch = setAiState.mock.calls[0][1] as { pausedUntil: Date | null };
      expect(patch.pausedUntil).toBeInstanceOf(Date);
      const until = patch.pausedUntil!.getTime();
      expect(until).toBeGreaterThanOrEqual(before + 60 * 60_000);
      expect(until).toBeLessThanOrEqual(after + 60 * 60_000);
    });

    it('sets pausedUntil=null when durationMinutes is not provided', async () => {
      const { svc, getById, setAiState, recordEvent } = makeMocks();
      getById.mockResolvedValue(makeConvo());
      setAiState.mockResolvedValue(makeConvo({ aiState: 'paused' }));
      recordEvent.mockResolvedValue({});

      await svc.pause(CONV_ID, ACTOR, {});

      const patch = setAiState.mock.calls[0][1] as { pausedUntil: null };
      expect(patch.pausedUntil).toBeNull();
    });

    it('records a pause event with fromState, toState=paused, metadata:{durationMinutes}', async () => {
      const { svc, getById, setAiState, recordEvent } = makeMocks();
      getById.mockResolvedValue(makeConvo({ aiState: 'bot' }));
      setAiState.mockResolvedValue(makeConvo({ aiState: 'paused' }));
      recordEvent.mockResolvedValue({});

      await svc.pause(CONV_ID, ACTOR, { reason: 'test', durationMinutes: 60 });

      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: CONV_ID,
          type: 'pause',
          actor: ACTOR,
          actorType: 'admin',
          fromState: 'bot',
          toState: 'paused',
          metadata: { durationMinutes: 60 },
        }),
      );
    });

    it('records metadata=null when durationMinutes is absent', async () => {
      const { svc, getById, setAiState, recordEvent } = makeMocks();
      getById.mockResolvedValue(makeConvo());
      setAiState.mockResolvedValue(makeConvo({ aiState: 'paused' }));
      recordEvent.mockResolvedValue({});

      await svc.pause(CONV_ID, ACTOR, {});

      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: null }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // resume
  // -------------------------------------------------------------------------

  describe('resume', () => {
    it('calls setAiState with aiState=bot, pausedUntil=null, and humanSummary when provided', async () => {
      const { svc, getById, setAiState, recordEvent } = makeMocks();
      getById.mockResolvedValue(makeConvo({ aiState: 'paused' }));
      setAiState.mockResolvedValue(makeConvo({ aiState: 'bot' }));
      recordEvent.mockResolvedValue({});

      await svc.resume(CONV_ID, ACTOR, { summary: 'Customer agreed to size 2' });

      expect(setAiState).toHaveBeenCalledWith(
        CONV_ID,
        expect.objectContaining({
          aiState: 'bot',
          pausedUntil: null,
          humanSummary: 'Customer agreed to size 2',
        }),
      );
    });

    it('does NOT include humanSummary in the patch when summary is absent', async () => {
      const { svc, getById, setAiState, recordEvent } = makeMocks();
      getById.mockResolvedValue(makeConvo({ aiState: 'paused' }));
      setAiState.mockResolvedValue(makeConvo({ aiState: 'bot' }));
      recordEvent.mockResolvedValue({});

      await svc.resume(CONV_ID, ACTOR, {});

      const patch = setAiState.mock.calls[0][1] as Record<string, unknown>;
      expect(patch).not.toHaveProperty('humanSummary');
    });

    it('records a resume event with toState=bot', async () => {
      const { svc, getById, setAiState, recordEvent } = makeMocks();
      getById.mockResolvedValue(makeConvo({ aiState: 'paused' }));
      setAiState.mockResolvedValue(makeConvo({ aiState: 'bot' }));
      recordEvent.mockResolvedValue({});

      await svc.resume(CONV_ID, ACTOR, {});

      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'resume',
          fromState: 'paused',
          toState: 'bot',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // assign
  // -------------------------------------------------------------------------

  describe('assign', () => {
    it('sets aiState=human and assignedTo when assignedTo is non-null', async () => {
      const { svc, getById, setAiState, recordEvent } = makeMocks();
      getById.mockResolvedValue(makeConvo({ aiState: 'bot' }));
      setAiState.mockResolvedValue(makeConvo({ aiState: 'human', assignedTo: 'agent@masa.com' }));
      recordEvent.mockResolvedValue({});

      await svc.assign(CONV_ID, ACTOR, { assignedTo: 'agent@masa.com' });

      expect(setAiState).toHaveBeenCalledWith(
        CONV_ID,
        expect.objectContaining({
          aiState: 'human',
          assignedTo: 'agent@masa.com',
        }),
      );
    });

    it('records an assign event with toState=human when assignedTo is non-null', async () => {
      const { svc, getById, setAiState, recordEvent } = makeMocks();
      getById.mockResolvedValue(makeConvo({ aiState: 'bot' }));
      setAiState.mockResolvedValue(makeConvo({ aiState: 'human' }));
      recordEvent.mockResolvedValue({});

      await svc.assign(CONV_ID, ACTOR, { assignedTo: 'agent@masa.com' });

      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'assign',
          toState: 'human',
          metadata: { assignedTo: 'agent@masa.com' },
        }),
      );
    });

    it('sets assignedTo=null only (aiState unchanged) when assignedTo is null', async () => {
      const { svc, getById, setAiState, recordEvent } = makeMocks();
      getById.mockResolvedValue(makeConvo({ aiState: 'human', assignedTo: 'agent@masa.com' }));
      setAiState.mockResolvedValue(makeConvo({ aiState: 'human', assignedTo: null }));
      recordEvent.mockResolvedValue({});

      await svc.assign(CONV_ID, ACTOR, { assignedTo: null });

      expect(setAiState).toHaveBeenCalledWith(CONV_ID, { assignedTo: null });
    });

    it('records an assign event with toState=fromState when assignedTo is null', async () => {
      const { svc, getById, setAiState, recordEvent } = makeMocks();
      getById.mockResolvedValue(makeConvo({ aiState: 'human' }));
      setAiState.mockResolvedValue(makeConvo({ aiState: 'human', assignedTo: null }));
      recordEvent.mockResolvedValue({});

      await svc.assign(CONV_ID, ACTOR, { assignedTo: null });

      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'assign',
          fromState: 'human',
          toState: 'human', // state unchanged on unassign
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // handoff
  // -------------------------------------------------------------------------

  describe('handoff', () => {
    it('calls setAiState with aiState=human and handoffReason', async () => {
      const { svc, getById, setAiState, recordEvent } = makeMocks();
      getById.mockResolvedValue(makeConvo({ aiState: 'bot' }));
      setAiState.mockResolvedValue(makeConvo({ aiState: 'human' }));
      recordEvent.mockResolvedValue({});

      await svc.handoff(CONV_ID, ACTOR, { reason: 'Custom size request' });

      expect(setAiState).toHaveBeenCalledWith(
        CONV_ID,
        expect.objectContaining({
          aiState: 'human',
          handoffReason: 'Custom size request',
        }),
      );
    });

    it('records a handoff event', async () => {
      const { svc, getById, setAiState, recordEvent } = makeMocks();
      getById.mockResolvedValue(makeConvo({ aiState: 'bot' }));
      setAiState.mockResolvedValue(makeConvo({ aiState: 'human' }));
      recordEvent.mockResolvedValue({});

      await svc.handoff(CONV_ID, ACTOR, { reason: 'size' });

      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'handoff',
          toState: 'human',
          actor: ACTOR,
          actorType: 'admin',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // sendHumanMessage
  // -------------------------------------------------------------------------

  describe('sendHumanMessage', () => {
    it('throws BadRequestException when aiState is bot', async () => {
      const { svc, getById, addMessage, sendText } = makeMocks();
      getById.mockResolvedValue(makeConvo({ aiState: 'bot' }));

      await expect(
        svc.sendHumanMessage(CONV_ID, ACTOR, { text: 'مرحبا' }),
      ).rejects.toThrow(BadRequestException);

      expect(addMessage).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
    });

    it('happy path: persists message before send, calls sendText(psid, text, true), records event, returns {message, delivered:true}', async () => {
      const { svc, getById, addMessage, sendText, recordEvent, findMessageByExternalId } = makeMocks();
      const convo = makeConvo({ aiState: 'human' });
      const msg = makeMsg({ id: 'new-msg-1', content: 'سيتم التوصيل غداً' });
      getById.mockResolvedValue(convo);
      findMessageByExternalId.mockResolvedValue(undefined);
      addMessage.mockResolvedValue(msg);
      sendText.mockResolvedValue(undefined); // sendText returns void
      recordEvent.mockResolvedValue({});

      const result = await svc.sendHumanMessage(
        CONV_ID,
        ACTOR,
        { text: 'سيتم التوصيل غداً' },
        'idem-key-1',
      );

      // addMessage must be called before sendText (persist-first ordering).
      const addOrder = addMessage.mock.invocationCallOrder[0];
      const sendOrder = sendText.mock.invocationCallOrder[0];
      expect(addOrder).toBeLessThan(sendOrder);

      // sendText is called with (psid, text, true) — humanAgent flag set.
      expect(sendText).toHaveBeenCalledWith(PSID, 'سيتم التوصيل غداً', true);

      expect(addMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: CONV_ID,
          role: 'human',
          content: 'سيتم التوصيل غداً',
          externalId: 'idem-key-1',
        }),
      );
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'human_message',
          metadata: expect.objectContaining({ messageId: 'new-msg-1', delivered: true }),
        }),
      );
      expect(result).toEqual({ message: msg, delivered: true });
    });

    it('idempotent: returns {message:existing, delivered:false} without calling addMessage or sendText', async () => {
      const { svc, getById, addMessage, sendText, findMessageByExternalId } = makeMocks();
      getById.mockResolvedValue(makeConvo({ aiState: 'human' }));
      const existing = makeMsg({ id: 'existing-msg', externalId: 'idem-key-dup' });
      findMessageByExternalId.mockResolvedValue(existing);

      const result = await svc.sendHumanMessage(
        CONV_ID,
        ACTOR,
        { text: 'سيتم التوصيل غداً' },
        'idem-key-dup',
      );

      expect(addMessage).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
      expect(result).toEqual({ message: existing, delivered: false });
    });

    it('propagates NotFoundException when getById throws', async () => {
      const { svc, getById } = makeMocks();
      getById.mockRejectedValue(new NotFoundException(`Conversation ${CONV_ID} not found`));

      await expect(
        svc.sendHumanMessage(CONV_ID, ACTOR, { text: 'مرحبا' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('delivered=false when sendText throws (MessengerSendError); message still persisted', async () => {
      const { svc, getById, addMessage, sendText, recordEvent, findMessageByExternalId } = makeMocks();
      getById.mockResolvedValue(makeConvo({ aiState: 'human' }));
      findMessageByExternalId.mockResolvedValue(undefined);
      const msg = makeMsg({ id: 'msg-fail-send' });
      addMessage.mockResolvedValue(msg);
      // Simulate Messenger send failure (MessengerSendError is a plain Error subclass)
      sendText.mockRejectedValue(new Error('MessengerSendError: 403'));
      recordEvent.mockResolvedValue({});

      const result = await svc.sendHumanMessage(CONV_ID, ACTOR, { text: 'test' }, 'k');

      // Message was persisted despite send failure.
      expect(addMessage).toHaveBeenCalledTimes(1);
      // Event records delivered=false.
      expect(recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ delivered: false }),
        }),
      );
      expect(result.delivered).toBe(false);
      expect(result.message).toBe(msg);
    });
  });

  // -------------------------------------------------------------------------
  // getThread
  // -------------------------------------------------------------------------

  describe('getThread', () => {
    it('returns {conversation, messages} from getById + listMessages(asc)', async () => {
      const { svc, getById, listMessages } = makeMocks();
      const convo = makeConvo();
      const msgs = [makeMsg({ id: 'msg-a' }), makeMsg({ id: 'msg-b' })];
      getById.mockResolvedValue(convo);
      listMessages.mockResolvedValue(msgs);

      const result = await svc.getThread(CONV_ID);

      expect(getById).toHaveBeenCalledWith(CONV_ID);
      expect(listMessages).toHaveBeenCalledWith(CONV_ID, { orderBy: 'asc' });
      expect(result).toEqual({ conversation: convo, messages: msgs });
    });

    it('propagates NotFoundException from getById', async () => {
      const { svc, getById } = makeMocks();
      getById.mockRejectedValue(new NotFoundException('not found'));

      await expect(svc.getThread(CONV_ID)).rejects.toThrow(NotFoundException);
    });
  });

  // -------------------------------------------------------------------------
  // listConversations
  // -------------------------------------------------------------------------

  describe('listConversations', () => {
    it('maps rows: escalated=true when handoffReason is non-null, unreadCount=0, customer=psid', async () => {
      const { svc, listWithPreview } = makeMocks();
      const lastAt = new Date('2025-06-01T12:00:00Z');
      const row = {
        id: CONV_ID,
        psid: PSID,
        aiState: 'human',
        assignedTo: 'agent@masa.com',
        handoffReason: 'size issue',
        lastMessagePreview: 'مرحبا',
        lastMessageAt: lastAt,
      };
      listWithPreview.mockResolvedValue({ items: [row], total: 1 });

      const result = await svc.listConversations({ limit: 10, offset: 0 });

      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item.escalated).toBe(true);
      expect(item.unreadCount).toBe(0);
      expect(item.customer).toBe(PSID);
      expect(item.lastMessageAt).toBe(lastAt.toISOString());
    });

    it('maps rows: escalated=false when handoffReason is null', async () => {
      const { svc, listWithPreview } = makeMocks();
      listWithPreview.mockResolvedValue({
        items: [
          {
            id: CONV_ID,
            psid: PSID,
            aiState: 'bot',
            assignedTo: null,
            handoffReason: null,
            lastMessagePreview: null,
            lastMessageAt: null,
          },
        ],
        total: 1,
      });

      const result = await svc.listConversations({});

      expect(result.items[0].escalated).toBe(false);
      expect(result.items[0].lastMessageAt).toBeNull();
    });

    it('returns {items, total, limit, offset} shape', async () => {
      const { svc, listWithPreview } = makeMocks();
      listWithPreview.mockResolvedValue({ items: [], total: 42 });

      const result = await svc.listConversations({ limit: 20, offset: 5 });

      expect(result.total).toBe(42);
      expect(result.limit).toBe(20);
      expect(result.offset).toBe(5);
    });
  });
});
