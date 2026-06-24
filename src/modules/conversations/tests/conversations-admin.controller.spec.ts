/**
 * Unit tests for ConversationsAdminController (WS5 + WS6 — AIA-34).
 *
 * ConversationControlService is fully mocked — no database or network calls.
 * Guards are not applied (NestJS DI context is not bootstrapped). Guard/role
 * metadata is verified via Reflect.getMetadata, mirroring the pattern used in
 * other admin controller specs in this repo.
 *
 * Coverage:
 *  - Each route handler delegates to the matching service method with the
 *    correct args (id, user.email as actor, parsed body, idempotency-key header).
 *  - @Roles metadata declares 'admin' and 'editor'.
 *  - Zod schemas reject invalid bodies (pauseConversationSchema,
 *    humanMessageSchema, listConversationsQuerySchema).
 */

// flydrive is ESM-only; stub it so the formatter import chain doesn't try to
// load the real module under Jest (CJS).
jest.mock('flydrive', () => ({ Disk: jest.fn() }));
jest.mock('flydrive/drivers/fs', () => ({ FSDriver: jest.fn() }));
jest.mock('flydrive/drivers/s3', () => ({ S3Driver: jest.fn() }));

import { ConversationsAdminController } from '../conversations-admin.controller';
import { ROLES_KEY } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import {
  pauseConversationSchema,
  humanMessageSchema,
  listConversationsQuerySchema,
  resumeConversationSchema,
  assignConversationSchema,
  handoffConversationSchema,
} from '../dto/conversation-control.dto';
import type { ConversationControlService } from '../conversation-control.service';
import type { Conversation } from '../entities/conversation.entity';
import type { Message } from '../entities/message.entity';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONV_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const USER = { email: 'admin@masafashion.com', role: 'admin' };

function makeConvo(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: CONV_ID,
    psid: 'psid-001',
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

function makeMockService() {
  return {
    listConversations: jest.fn(),
    getThread: jest.fn(),
    pause: jest.fn(),
    resume: jest.fn(),
    assign: jest.fn(),
    handoff: jest.fn(),
    sendHumanMessage: jest.fn(),
  } as unknown as ConversationControlService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConversationsAdminController', () => {
  let control: ReturnType<typeof makeMockService>;
  let ctrl: ConversationsAdminController;

  beforeEach(() => {
    jest.clearAllMocks();
    control = makeMockService();
    ctrl = new ConversationsAdminController(control);
  });

  // -------------------------------------------------------------------------
  // Guard + role metadata
  // -------------------------------------------------------------------------

  describe('metadata', () => {
    it('declares @Roles("admin", "editor") on the controller class', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, ConversationsAdminController);
      expect(roles).toEqual(['admin', 'editor']);
    });

    it('applies JwtAuthGuard via @UseGuards on the controller', () => {
      // NestJS stores guards in __guards__ metadata on the target.
      const guards: unknown[] = Reflect.getMetadata(
        '__guards__',
        ConversationsAdminController,
      ) ?? [];
      expect(guards).toContain(JwtAuthGuard);
    });

    it('applies RolesGuard via @UseGuards on the controller', () => {
      const guards: unknown[] = Reflect.getMetadata(
        '__guards__',
        ConversationsAdminController,
      ) ?? [];
      expect(guards).toContain(RolesGuard);
    });
  });

  // -------------------------------------------------------------------------
  // GET /admin/conversations
  // -------------------------------------------------------------------------

  describe('list', () => {
    it('delegates to control.listConversations with the parsed query', async () => {
      const expected = { items: [], total: 0, limit: 10, offset: 0 };
      (control.listConversations as jest.Mock).mockResolvedValue(expected);

      const result = await ctrl.list({ limit: 10, offset: 0, state: 'bot' });

      expect(control.listConversations).toHaveBeenCalledWith({ limit: 10, offset: 0, state: 'bot' });
      expect(result).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // GET /admin/conversations/:id
  // -------------------------------------------------------------------------

  describe('getOne', () => {
    it('returns serialized conversation + messages from control.getThread', async () => {
      const convo = makeConvo({ pausedUntil: null });
      const msgs = [makeMsg({ id: 'msg-a' })];
      (control.getThread as jest.Mock).mockResolvedValue({ conversation: convo, messages: msgs });

      const result = await ctrl.getOne(CONV_ID);

      expect(control.getThread).toHaveBeenCalledWith(CONV_ID);
      expect(result.conversation.id).toBe(CONV_ID);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].id).toBe('msg-a');
    });

    it('serializes dates to ISO strings', async () => {
      const convo = makeConvo({
        pausedUntil: new Date('2025-06-01T10:00:00Z'),
        createdAt: new Date('2025-01-01T00:00:00Z'),
      });
      (control.getThread as jest.Mock).mockResolvedValue({ conversation: convo, messages: [] });

      const result = await ctrl.getOne(CONV_ID);

      expect(result.conversation.pausedUntil).toBe('2025-06-01T10:00:00.000Z');
      expect(result.conversation.createdAt).toBe('2025-01-01T00:00:00.000Z');
    });

    it('sets pausedUntil=null when the conversation has no pausedUntil', async () => {
      (control.getThread as jest.Mock).mockResolvedValue({
        conversation: makeConvo({ pausedUntil: null }),
        messages: [],
      });

      const result = await ctrl.getOne(CONV_ID);

      expect(result.conversation.pausedUntil).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // POST /admin/conversations/:id/pause
  // -------------------------------------------------------------------------

  describe('pause', () => {
    it('delegates to control.pause with id, user.email, and body', async () => {
      const updated = makeConvo({ aiState: 'paused' });
      (control.pause as jest.Mock).mockResolvedValue(updated);
      const body = { reason: 'Customer upset', durationMinutes: 60 };

      const result = await ctrl.pause(CONV_ID, body, USER);

      expect(control.pause).toHaveBeenCalledWith(CONV_ID, USER.email, body);
      expect(result).toBe(updated);
    });

    it('uses user.email (not user.role) as the actor', async () => {
      (control.pause as jest.Mock).mockResolvedValue(makeConvo());

      await ctrl.pause(CONV_ID, {}, USER);

      const [, actorArg] = (control.pause as jest.Mock).mock.calls[0];
      expect(actorArg).toBe(USER.email);
    });
  });

  // -------------------------------------------------------------------------
  // POST /admin/conversations/:id/resume
  // -------------------------------------------------------------------------

  describe('resume', () => {
    it('delegates to control.resume with id, user.email, and body', async () => {
      (control.resume as jest.Mock).mockResolvedValue(makeConvo({ aiState: 'bot' }));
      const body = { summary: 'Customer agreed' };

      await ctrl.resume(CONV_ID, body, USER);

      expect(control.resume).toHaveBeenCalledWith(CONV_ID, USER.email, body);
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /admin/conversations/:id/assignment
  // -------------------------------------------------------------------------

  describe('assign', () => {
    it('delegates to control.assign with id, user.email, and body', async () => {
      (control.assign as jest.Mock).mockResolvedValue(makeConvo({ aiState: 'human' }));
      const body = { assignedTo: 'agent@masa.com' };

      await ctrl.assign(CONV_ID, body, USER);

      expect(control.assign).toHaveBeenCalledWith(CONV_ID, USER.email, body);
    });

    it('passes assignedTo=null to control.assign when body has null', async () => {
      (control.assign as jest.Mock).mockResolvedValue(makeConvo());

      await ctrl.assign(CONV_ID, { assignedTo: null }, USER);

      const [, , bodyArg] = (control.assign as jest.Mock).mock.calls[0];
      expect(bodyArg).toEqual({ assignedTo: null });
    });
  });

  // -------------------------------------------------------------------------
  // POST /admin/conversations/:id/handoff
  // -------------------------------------------------------------------------

  describe('handoff', () => {
    it('delegates to control.handoff with id, user.email, and body', async () => {
      (control.handoff as jest.Mock).mockResolvedValue(makeConvo({ aiState: 'human' }));
      const body = { reason: 'Custom size' };

      await ctrl.handoff(CONV_ID, body, USER);

      expect(control.handoff).toHaveBeenCalledWith(CONV_ID, USER.email, body);
    });
  });

  // -------------------------------------------------------------------------
  // POST /admin/conversations/:id/messages
  // -------------------------------------------------------------------------

  describe('sendMessage', () => {
    it('delegates to control.sendHumanMessage with id, user.email, body, and idempotency-key header', async () => {
      const msg = makeMsg({ id: 'sent-msg' });
      (control.sendHumanMessage as jest.Mock).mockResolvedValue({ message: msg, delivered: true });
      const body = { text: 'طلبك جاهز للتوصيل' };

      await ctrl.sendMessage(CONV_ID, body, USER, 'idem-key-abc');

      expect(control.sendHumanMessage).toHaveBeenCalledWith(
        CONV_ID,
        USER.email,
        body,
        'idem-key-abc',
      );
    });

    it('passes undefined idempotencyKey when the header is not present', async () => {
      (control.sendHumanMessage as jest.Mock).mockResolvedValue({
        message: makeMsg(),
        delivered: true,
      });

      await ctrl.sendMessage(CONV_ID, { text: 'hello' }, USER, undefined);

      const [, , , keyArg] = (control.sendHumanMessage as jest.Mock).mock.calls[0];
      expect(keyArg).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Zod schema validation (tested directly against the exported schemas)
  // -------------------------------------------------------------------------

  describe('Zod schema validation', () => {
    describe('pauseConversationSchema', () => {
      it('accepts a valid body', () => {
        expect(
          pauseConversationSchema.safeParse({ reason: 'test', durationMinutes: 60 }).success,
        ).toBe(true);
      });

      it('accepts an empty body (all fields optional)', () => {
        expect(pauseConversationSchema.safeParse({}).success).toBe(true);
      });

      it('rejects durationMinutes <= 0', () => {
        expect(pauseConversationSchema.safeParse({ durationMinutes: 0 }).success).toBe(false);
        expect(pauseConversationSchema.safeParse({ durationMinutes: -1 }).success).toBe(false);
      });

      it('rejects durationMinutes > 1440', () => {
        expect(pauseConversationSchema.safeParse({ durationMinutes: 1441 }).success).toBe(false);
      });

      it('rejects unknown keys (strict)', () => {
        expect(pauseConversationSchema.safeParse({ reason: 'ok', extra: true }).success).toBe(false);
      });
    });

    describe('humanMessageSchema', () => {
      it('accepts a valid body with non-empty text', () => {
        expect(humanMessageSchema.safeParse({ text: 'مرحبا' }).success).toBe(true);
      });

      it('rejects an empty text string', () => {
        expect(humanMessageSchema.safeParse({ text: '' }).success).toBe(false);
      });

      it('rejects a missing text field', () => {
        expect(humanMessageSchema.safeParse({}).success).toBe(false);
      });

      it('rejects unknown keys (strict)', () => {
        expect(humanMessageSchema.safeParse({ text: 'ok', extra: true }).success).toBe(false);
      });
    });

    describe('listConversationsQuerySchema', () => {
      it('accepts an empty query object', () => {
        expect(listConversationsQuerySchema.safeParse({}).success).toBe(true);
      });

      it('rejects state values not in the AI_STATES enum', () => {
        expect(listConversationsQuerySchema.safeParse({ state: 'nope' }).success).toBe(false);
      });

      it('accepts state values in the AI_STATES enum', () => {
        expect(listConversationsQuerySchema.safeParse({ state: 'bot' }).success).toBe(true);
        expect(listConversationsQuerySchema.safeParse({ state: 'human' }).success).toBe(true);
        expect(listConversationsQuerySchema.safeParse({ state: 'paused' }).success).toBe(true);
      });

      it('rejects unknown keys (strict)', () => {
        expect(listConversationsQuerySchema.safeParse({ foo: 'bar' }).success).toBe(false);
      });
    });

    describe('resumeConversationSchema', () => {
      it('accepts an empty body', () => {
        expect(resumeConversationSchema.safeParse({}).success).toBe(true);
      });

      it('accepts a non-empty summary', () => {
        expect(resumeConversationSchema.safeParse({ summary: 'done' }).success).toBe(true);
      });

      it('rejects empty summary string', () => {
        expect(resumeConversationSchema.safeParse({ summary: '' }).success).toBe(false);
      });
    });

    describe('assignConversationSchema', () => {
      it('accepts a string assignedTo', () => {
        expect(assignConversationSchema.safeParse({ assignedTo: 'agent@masa.com' }).success).toBe(true);
      });

      it('accepts assignedTo=null', () => {
        expect(assignConversationSchema.safeParse({ assignedTo: null }).success).toBe(true);
      });

      it('rejects a missing assignedTo field', () => {
        expect(assignConversationSchema.safeParse({}).success).toBe(false);
      });
    });

    describe('handoffConversationSchema', () => {
      it('accepts an empty body', () => {
        expect(handoffConversationSchema.safeParse({}).success).toBe(true);
      });

      it('accepts a reason', () => {
        expect(handoffConversationSchema.safeParse({ reason: 'size' }).success).toBe(true);
      });

      it('rejects empty reason string', () => {
        expect(handoffConversationSchema.safeParse({ reason: '' }).success).toBe(false);
      });
    });
  });
});
