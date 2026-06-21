/**
 * Contract tests for ManyChatControlService.
 *
 * Mirrors the style of manychat-sender.service.contract.spec.ts:
 *  - ConfigService is mocked via a plain object with a `get` method.
 *  - global.fetch is replaced with a jest.fn() before each test.
 *  - Each test asserts a specific dimension of the outgoing HTTP request
 *    (URL, method, Authorization header, JSON body) or the service's
 *    best-effort resilience (disabled, no-token, non-2xx, network error).
 */

import { ManyChatControlService } from '../manychat-control.service';
import type { ConfigService } from '@nestjs/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN = 'test-control-token-xyz';
const BASE = 'https://api.manychat.com';
const SUBSCRIBER_ID = 'subscriber-ctrl-01';

/**
 * Build a ManyChatControlService with the given config key→value map.
 * Keys not in the map return undefined (same as ConfigService.get when unset).
 */
function makeControl(cfg: Record<string, string | undefined>): ManyChatControlService {
  const config = { get: (k: string) => cfg[k] } as unknown as ConfigService;
  return new ManyChatControlService(config);
}

/** Returns a resolved-ok fetch mock. */
function okFetch() {
  (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
}

/** Returns a resolved-non-ok fetch mock. */
function failFetch(status = 500) {
  (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status });
}

/** Returns the parsed JSON body from the first fetch call. */
function calledBody(): unknown {
  const [, init] = (global.fetch as jest.Mock).mock.calls[0];
  return JSON.parse((init as RequestInit).body as string);
}

/** Returns the first fetch call's URL string. */
function calledUrl(): string {
  const [url] = (global.fetch as jest.Mock).mock.calls[0];
  return url as string;
}

/** Returns the first fetch call's RequestInit. */
function calledInit(): RequestInit {
  const [, init] = (global.fetch as jest.Mock).mock.calls[0];
  return init as RequestInit;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ManyChatControlService — Public API contract', () => {
  beforeEach(() => {
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // setCustomFieldByName
  // -------------------------------------------------------------------------

  describe('setCustomFieldByName', () => {
    it('POSTs to /fb/subscriber/setCustomFieldByName with the correct URL', async () => {
      okFetch();
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN, MANYCHAT_API_BASE: BASE });

      await svc.setCustomFieldByName(SUBSCRIBER_ID, 'ai_state', 'human');

      expect(calledUrl()).toBe(`${BASE}/fb/subscriber/setCustomFieldByName`);
    });

    it('uses POST method', async () => {
      okFetch();
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN, MANYCHAT_API_BASE: BASE });

      await svc.setCustomFieldByName(SUBSCRIBER_ID, 'ai_state', 'human');

      expect(calledInit().method).toBe('POST');
    });

    it('sends Authorization: Bearer <token>', async () => {
      okFetch();
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN, MANYCHAT_API_BASE: BASE });

      await svc.setCustomFieldByName(SUBSCRIBER_ID, 'ai_state', 'human');

      const headers = calledInit().headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('sends the correct JSON body with subscriber_id, field_name, and field_value', async () => {
      okFetch();
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN, MANYCHAT_API_BASE: BASE });

      await svc.setCustomFieldByName(SUBSCRIBER_ID, 'ai_state', 'human');

      expect(calledBody()).toEqual({
        subscriber_id: SUBSCRIBER_ID,
        field_name: 'ai_state',
        field_value: 'human',
      });
    });

    it('returns true on a 2xx response', async () => {
      okFetch();
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN });

      const result = await svc.setCustomFieldByName(SUBSCRIBER_ID, 'ai_state', 'human');

      expect(result).toBe(true);
    });

    it('returns false on a non-2xx response without throwing', async () => {
      failFetch(422);
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN });

      await expect(svc.setCustomFieldByName(SUBSCRIBER_ID, 'ai_state', 'human')).resolves.toBe(false);
    });

    it('returns false on a network error without throwing', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new TypeError('fetch failed'));
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN });

      await expect(svc.setCustomFieldByName(SUBSCRIBER_ID, 'ai_state', 'human')).resolves.toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // setCustomFields
  // -------------------------------------------------------------------------

  describe('setCustomFields', () => {
    it('POSTs to /fb/subscriber/setCustomFields', async () => {
      okFetch();
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN, MANYCHAT_API_BASE: BASE });
      const fields = [{ field_name: 'ai_state', field_value: 'bot' }];

      await svc.setCustomFields(SUBSCRIBER_ID, fields);

      expect(calledUrl()).toBe(`${BASE}/fb/subscriber/setCustomFields`);
    });

    it('sends the correct JSON body with subscriber_id and fields array', async () => {
      okFetch();
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN, MANYCHAT_API_BASE: BASE });
      const fields = [{ field_name: 'a', field_value: 1 }];

      await svc.setCustomFields(SUBSCRIBER_ID, fields);

      expect(calledBody()).toEqual({
        subscriber_id: SUBSCRIBER_ID,
        fields,
      });
    });
  });

  // -------------------------------------------------------------------------
  // addTagByName
  // -------------------------------------------------------------------------

  describe('addTagByName', () => {
    it('POSTs to /fb/subscriber/addTagByName with the correct body', async () => {
      okFetch();
      const svc = makeControl({
        MANYCHAT_API_TOKEN: TOKEN,
        MANYCHAT_API_BASE: BASE,
        MANYCHAT_HUMAN_TAG: 'ai_human',
      });

      await svc.addTagByName(SUBSCRIBER_ID, 'ai_human');

      expect(calledUrl()).toBe(`${BASE}/fb/subscriber/addTagByName`);
      expect(calledBody()).toEqual({
        subscriber_id: SUBSCRIBER_ID,
        tag_name: 'ai_human',
      });
    });

    it('uses the Authorization: Bearer <token> header', async () => {
      okFetch();
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN, MANYCHAT_API_BASE: BASE });

      await svc.addTagByName(SUBSCRIBER_ID, 'ai_human');

      const headers = calledInit().headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });
  });

  // -------------------------------------------------------------------------
  // removeTagByName
  // -------------------------------------------------------------------------

  describe('removeTagByName', () => {
    it('POSTs to /fb/subscriber/removeTagByName with the correct body', async () => {
      okFetch();
      const svc = makeControl({
        MANYCHAT_API_TOKEN: TOKEN,
        MANYCHAT_API_BASE: BASE,
        MANYCHAT_HUMAN_TAG: 'ai_human',
      });

      await svc.removeTagByName(SUBSCRIBER_ID, 'ai_human');

      expect(calledUrl()).toBe(`${BASE}/fb/subscriber/removeTagByName`);
      expect(calledBody()).toEqual({
        subscriber_id: SUBSCRIBER_ID,
        tag_name: 'ai_human',
      });
    });
  });

  // -------------------------------------------------------------------------
  // sendFlow — NOTE: field is flow_ns, NOT flow_id
  // -------------------------------------------------------------------------

  describe('sendFlow', () => {
    it('POSTs to /fb/sending/sendFlow', async () => {
      okFetch();
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN, MANYCHAT_API_BASE: BASE });

      await svc.sendFlow(SUBSCRIBER_ID, 'flow123');

      expect(calledUrl()).toBe(`${BASE}/fb/sending/sendFlow`);
    });

    it('sends the body with flow_ns (not flow_id)', async () => {
      okFetch();
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN, MANYCHAT_API_BASE: BASE });

      await svc.sendFlow(SUBSCRIBER_ID, 'flow123');

      const body = calledBody() as Record<string, unknown>;
      expect(body.flow_ns).toBe('flow123');
      expect(body).not.toHaveProperty('flow_id');
    });

    it('sends subscriber_id in the body', async () => {
      okFetch();
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN, MANYCHAT_API_BASE: BASE });

      await svc.sendFlow(SUBSCRIBER_ID, 'flow123');

      expect((calledBody() as Record<string, unknown>).subscriber_id).toBe(SUBSCRIBER_ID);
    });
  });

  // -------------------------------------------------------------------------
  // getInfo — GET with query param
  // -------------------------------------------------------------------------

  describe('getInfo', () => {
    it('uses GET (not POST)', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { name: 'Test' } }),
      });
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN, MANYCHAT_API_BASE: BASE });

      await svc.getInfo(SUBSCRIBER_ID);

      const init = calledInit();
      expect(init.method).toBe('GET');
    });

    it('includes subscriber_id as a query param (not in body)', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { name: 'Test' } }),
      });
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN, MANYCHAT_API_BASE: BASE });

      await svc.getInfo(SUBSCRIBER_ID);

      const url = calledUrl();
      expect(url).toContain(`subscriber_id=${SUBSCRIBER_ID}`);
      expect(url).toContain('/fb/subscriber/getInfo');
    });

    it('sends Authorization: Bearer <token> header', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: {} }),
      });
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN, MANYCHAT_API_BASE: BASE });

      await svc.getInfo(SUBSCRIBER_ID);

      const headers = calledInit().headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('returns the .data field when present in the response', async () => {
      const data = { first_name: 'Nora', id: '999' };
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', data }),
      });
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN });

      const result = await svc.getInfo(SUBSCRIBER_ID);

      expect(result).toEqual(data);
    });

    it('returns the whole JSON when the response has no .data field', async () => {
      const json = { id: '999', name: 'Nora' };
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => json,
      });
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN });

      const result = await svc.getInfo(SUBSCRIBER_ID);

      expect(result).toEqual(json);
    });

    it('returns null on non-2xx response without throwing', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 403 });
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN });

      await expect(svc.getInfo(SUBSCRIBER_ID)).resolves.toBeNull();
    });

    it('returns null on a network error without throwing', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new TypeError('network down'));
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN });

      await expect(svc.getInfo(SUBSCRIBER_ID)).resolves.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Best-effort / kill-switch behaviour
  // -------------------------------------------------------------------------

  describe('MANYCHAT_ENABLED=false or missing token — no fetch, returns false/null', () => {
    it('POST methods return false and do NOT call fetch when MANYCHAT_ENABLED=false', async () => {
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN, MANYCHAT_ENABLED: 'false' });

      const r1 = await svc.setCustomFieldByName(SUBSCRIBER_ID, 'ai_state', 'human');
      const r2 = await svc.addTagByName(SUBSCRIBER_ID, 'ai_human');
      const r3 = await svc.removeTagByName(SUBSCRIBER_ID, 'ai_human');
      const r4 = await svc.sendFlow(SUBSCRIBER_ID, 'flow-x');

      expect(r1).toBe(false);
      expect(r2).toBe(false);
      expect(r3).toBe(false);
      expect(r4).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('getInfo returns null and does NOT call fetch when MANYCHAT_ENABLED=false', async () => {
      const svc = makeControl({ MANYCHAT_API_TOKEN: TOKEN, MANYCHAT_ENABLED: 'false' });

      const result = await svc.getInfo(SUBSCRIBER_ID);

      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('POST methods return false and do NOT call fetch when token is missing', async () => {
      const svc = makeControl({});

      const result = await svc.setCustomFieldByName(SUBSCRIBER_ID, 'ai_state', 'human');

      expect(result).toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('getInfo returns null and does NOT call fetch when token is missing', async () => {
      const svc = makeControl({});

      const result = await svc.getInfo(SUBSCRIBER_ID);

      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // applyState — orchestration of field + tag + flow
  // -------------------------------------------------------------------------

  describe('applyState', () => {
    it('applyState("human") sets the ai_state field FIRST, then adds the human tag', async () => {
      okFetch();
      const svc = makeControl({
        MANYCHAT_API_TOKEN: TOKEN,
        MANYCHAT_API_BASE: BASE,
        MANYCHAT_AI_STATE_FIELD: 'ai_state',
        MANYCHAT_HUMAN_TAG: 'ai_human',
      });

      await svc.applyState(SUBSCRIBER_ID, 'human');

      const calls = (global.fetch as jest.Mock).mock.calls;
      // First call must set the custom field
      const firstUrl = calls[0][0] as string;
      const firstBody = JSON.parse((calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
      expect(firstUrl).toContain('/fb/subscriber/setCustomFieldByName');
      expect(firstBody.field_name).toBe('ai_state');
      expect(firstBody.field_value).toBe('human');

      // Second call must add the tag
      const secondUrl = calls[1][0] as string;
      expect(secondUrl).toContain('/fb/subscriber/addTagByName');
    });

    it('applyState("human") sends the pause flow when MANYCHAT_PAUSE_FLOW_ID is configured', async () => {
      okFetch();
      const svc = makeControl({
        MANYCHAT_API_TOKEN: TOKEN,
        MANYCHAT_API_BASE: BASE,
        MANYCHAT_AI_STATE_FIELD: 'ai_state',
        MANYCHAT_HUMAN_TAG: 'ai_human',
        MANYCHAT_PAUSE_FLOW_ID: 'pause-flow-ns',
      });

      await svc.applyState(SUBSCRIBER_ID, 'human');

      const urls = (global.fetch as jest.Mock).mock.calls.map(([u]) => u as string);
      const flowCall = urls.find((u) => u.includes('/fb/sending/sendFlow'));
      expect(flowCall).toBeDefined();

      const flowInit = (global.fetch as jest.Mock).mock.calls.find(([u]) =>
        (u as string).includes('/fb/sending/sendFlow'),
      )?.[1] as RequestInit;
      const flowBody = JSON.parse(flowInit.body as string) as Record<string, unknown>;
      expect(flowBody.flow_ns).toBe('pause-flow-ns');
    });

    it('applyState("human") does NOT send a flow when MANYCHAT_PAUSE_FLOW_ID is not set', async () => {
      okFetch();
      const svc = makeControl({
        MANYCHAT_API_TOKEN: TOKEN,
        MANYCHAT_API_BASE: BASE,
        MANYCHAT_AI_STATE_FIELD: 'ai_state',
        MANYCHAT_HUMAN_TAG: 'ai_human',
        // No MANYCHAT_PAUSE_FLOW_ID
      });

      await svc.applyState(SUBSCRIBER_ID, 'human');

      const urls = (global.fetch as jest.Mock).mock.calls.map(([u]) => u as string);
      expect(urls.some((u) => u.includes('/fb/sending/sendFlow'))).toBe(false);
    });

    it('applyState("paused") sets the ai_state field', async () => {
      okFetch();
      const svc = makeControl({
        MANYCHAT_API_TOKEN: TOKEN,
        MANYCHAT_API_BASE: BASE,
        MANYCHAT_AI_STATE_FIELD: 'ai_state',
      });

      await svc.applyState(SUBSCRIBER_ID, 'paused');

      const firstBody = JSON.parse(
        ((global.fetch as jest.Mock).mock.calls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(firstBody.field_value).toBe('paused');
    });

    it('applyState("paused") sends the pause flow when MANYCHAT_PAUSE_FLOW_ID is configured', async () => {
      okFetch();
      const svc = makeControl({
        MANYCHAT_API_TOKEN: TOKEN,
        MANYCHAT_API_BASE: BASE,
        MANYCHAT_AI_STATE_FIELD: 'ai_state',
        MANYCHAT_PAUSE_FLOW_ID: 'pause-flow-ns',
      });

      await svc.applyState(SUBSCRIBER_ID, 'paused');

      const urls = (global.fetch as jest.Mock).mock.calls.map(([u]) => u as string);
      expect(urls.some((u) => u.includes('/fb/sending/sendFlow'))).toBe(true);
    });

    it('applyState("paused") does NOT send a flow when MANYCHAT_PAUSE_FLOW_ID is not set', async () => {
      okFetch();
      const svc = makeControl({
        MANYCHAT_API_TOKEN: TOKEN,
        MANYCHAT_AI_STATE_FIELD: 'ai_state',
      });

      await svc.applyState(SUBSCRIBER_ID, 'paused');

      const calls = (global.fetch as jest.Mock).mock.calls;
      // Only the setCustomFieldByName call — no flow
      expect(calls).toHaveLength(1);
    });

    it('applyState("bot") sets the ai_state field and removes the human tag', async () => {
      okFetch();
      const svc = makeControl({
        MANYCHAT_API_TOKEN: TOKEN,
        MANYCHAT_API_BASE: BASE,
        MANYCHAT_AI_STATE_FIELD: 'ai_state',
        MANYCHAT_HUMAN_TAG: 'ai_human',
      });

      await svc.applyState(SUBSCRIBER_ID, 'bot');

      const calls = (global.fetch as jest.Mock).mock.calls;
      // First call: set field
      const firstUrl = calls[0][0] as string;
      expect(firstUrl).toContain('/fb/subscriber/setCustomFieldByName');
      // Second call: remove tag
      const secondUrl = calls[1][0] as string;
      expect(secondUrl).toContain('/fb/subscriber/removeTagByName');
    });

    it('applyState("bot") sends the resume flow when MANYCHAT_RESUME_FLOW_ID is configured', async () => {
      okFetch();
      const svc = makeControl({
        MANYCHAT_API_TOKEN: TOKEN,
        MANYCHAT_API_BASE: BASE,
        MANYCHAT_AI_STATE_FIELD: 'ai_state',
        MANYCHAT_HUMAN_TAG: 'ai_human',
        MANYCHAT_RESUME_FLOW_ID: 'resume-flow-ns',
      });

      await svc.applyState(SUBSCRIBER_ID, 'bot');

      const urls = (global.fetch as jest.Mock).mock.calls.map(([u]) => u as string);
      const flowCall = urls.find((u) => u.includes('/fb/sending/sendFlow'));
      expect(flowCall).toBeDefined();

      const flowInit = (global.fetch as jest.Mock).mock.calls.find(([u]) =>
        (u as string).includes('/fb/sending/sendFlow'),
      )?.[1] as RequestInit;
      const flowBody = JSON.parse(flowInit.body as string) as Record<string, unknown>;
      expect(flowBody.flow_ns).toBe('resume-flow-ns');
    });

    it('applyState("bot") does NOT send a flow when MANYCHAT_RESUME_FLOW_ID is not set', async () => {
      okFetch();
      const svc = makeControl({
        MANYCHAT_API_TOKEN: TOKEN,
        MANYCHAT_AI_STATE_FIELD: 'ai_state',
        MANYCHAT_HUMAN_TAG: 'ai_human',
      });

      await svc.applyState(SUBSCRIBER_ID, 'bot');

      const calls = (global.fetch as jest.Mock).mock.calls;
      expect(calls).toHaveLength(2); // setField + removeTag only
      const urls = calls.map(([u]) => u as string);
      expect(urls.some((u) => u.includes('/fb/sending/sendFlow'))).toBe(false);
    });

    it('applyState never throws even when an inner fetch rejects', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(new Error('network down'));
      const svc = makeControl({
        MANYCHAT_API_TOKEN: TOKEN,
        MANYCHAT_AI_STATE_FIELD: 'ai_state',
        MANYCHAT_HUMAN_TAG: 'ai_human',
      });

      // Must resolve, never reject
      await expect(svc.applyState(SUBSCRIBER_ID, 'human')).resolves.toBeUndefined();
    });
  });
});
