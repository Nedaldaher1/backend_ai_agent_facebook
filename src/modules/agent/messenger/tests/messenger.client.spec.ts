/**
 * Unit tests for MessengerClient.
 *
 * Covers:
 *  - sendText: RESPONSE messaging_type, NO tag for normal replies.
 *  - sendText humanAgent=true: MESSAGE_TAG + HUMAN_AGENT (no other tags).
 *  - URL includes v25.0 and page id but NOT the access token (token leak fix).
 *  - Authorization header carries Bearer token (not query string).
 *  - Skip (no fetch) when token or page id is missing (dev-friendly).
 *  - MessengerSendError thrown on non-2xx response.
 *  - senderAction builds correct payload.
 *  - sendTemplate builds generic template body.
 *  - sendQuickReplies builds quick_replies body.
 *
 * fetch is mocked globally so no real network calls are made.
 */

import { MessengerClient, MessengerSendError } from '../messenger.client';
import type { ConfigService } from '@nestjs/config';

// ---------------------------------------------------------------------------
// Stub helpers
// ---------------------------------------------------------------------------

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

function makeClient(env: Record<string, string | undefined>): MessengerClient {
  return new MessengerClient(makeConfig(env));
}

const BASE_ENV = {
  MESSENGER_GRAPH_VERSION: 'v25.0',
  MESSENGER_PAGE_ID: 'PAGE-123',
  MESSENGER_PAGE_ACCESS_TOKEN: 'PAGE-TOKEN-XYZ',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessengerClient', () => {
  beforeEach(() => {
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // sendText — RESPONSE (no tag)
  // -------------------------------------------------------------------------

  it('sendText sends messaging_type RESPONSE with NO tag for a normal reply', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const client = makeClient(BASE_ENV);

    await client.sendText('PSID-1', 'أهلاً');

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.messaging_type).toBe('RESPONSE');
    expect(body.tag).toBeUndefined();
    expect(body.recipient).toEqual({ id: 'PSID-1' });
    expect(body.message).toEqual({ text: 'أهلاً' });
    // URL contains v25.0 and page id
    expect(url).toContain('v25.0');
    expect(url).toContain('PAGE-123');
    // Token must NOT appear in the URL (token leak fix — sent as Bearer header)
    expect(url).not.toContain('PAGE-TOKEN-XYZ');
    expect(url).not.toContain('access_token');
    // Token IS in the Authorization header
    expect(init.headers['Authorization']).toBe('Bearer PAGE-TOKEN-XYZ');
  });

  // -------------------------------------------------------------------------
  // sendText — humanAgent → MESSAGE_TAG + HUMAN_AGENT
  // -------------------------------------------------------------------------

  it('sendText with humanAgent=true uses MESSAGE_TAG and HUMAN_AGENT tag', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const client = makeClient(BASE_ENV);

    await client.sendText('PSID-1', 'رسالة من وكيل بشري', true);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.messaging_type).toBe('MESSAGE_TAG');
    expect(body.tag).toBe('HUMAN_AGENT');
  });

  it('NEVER sends a deprecated tag on normal replies (tag must be absent or HUMAN_AGENT only)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const client = makeClient(BASE_ENV);

    await client.sendText('PSID-1', 'رسالة عادية');

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body as string);
    // On a normal (in-window) reply, no deprecated tag should appear.
    // The only permitted tag is HUMAN_AGENT, used only when humanAgent=true.
    expect(body.tag).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // URL includes v25.0 and page id
  // -------------------------------------------------------------------------

  it('builds the Send API URL from MESSENGER_GRAPH_VERSION and MESSENGER_PAGE_ID (no token in URL)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const client = makeClient({
      ...BASE_ENV,
      MESSENGER_GRAPH_VERSION: 'v25.0',
      MESSENGER_PAGE_ID: 'MY-PAGE',
    });

    await client.sendText('PSID-1', 'test');

    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toContain('v25.0');
    expect(url).toContain('MY-PAGE');
    // Token must NOT be in the query string (security: token leak fix)
    expect(url).not.toContain('access_token');
    expect(url).not.toContain('PAGE-TOKEN-XYZ');
    // Token IS sent in the Authorization header
    expect(init.headers['Authorization']).toBe('Bearer PAGE-TOKEN-XYZ');
  });

  // -------------------------------------------------------------------------
  // Skip when credentials are absent
  // -------------------------------------------------------------------------

  it('logs and skips (no fetch) when MESSENGER_PAGE_ACCESS_TOKEN is absent', async () => {
    const client = makeClient({
      MESSENGER_GRAPH_VERSION: 'v25.0',
      MESSENGER_PAGE_ID: 'PAGE-123',
      // no token
    });

    await client.sendText('PSID-1', 'test');

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('logs and skips (no fetch) when MESSENGER_PAGE_ID is absent', async () => {
    const client = makeClient({
      MESSENGER_GRAPH_VERSION: 'v25.0',
      MESSENGER_PAGE_ACCESS_TOKEN: 'TOKEN',
      // no page id
    });

    await client.sendText('PSID-1', 'test');

    expect(global.fetch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // MessengerSendError on non-2xx
  // -------------------------------------------------------------------------

  it('throws MessengerSendError on a non-2xx Graph API response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid parameter', code: 100 } }),
    });
    const client = makeClient(BASE_ENV);

    await expect(client.sendText('PSID-1', 'test')).rejects.toThrow(MessengerSendError);
  });

  it('MessengerSendError carries the HTTP status and graph error body', async () => {
    const graphErrorBody = { error: { message: 'OAuthException', code: 190 } };
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => graphErrorBody,
    });
    const client = makeClient(BASE_ENV);

    let caught: MessengerSendError | undefined;
    try {
      await client.sendText('PSID-1', 'test');
    } catch (err) {
      caught = err as MessengerSendError;
    }

    expect(caught).toBeInstanceOf(MessengerSendError);
    expect(caught?.status).toBe(401);
    expect(caught?.graphError).toMatchObject(graphErrorBody);
  });

  // -------------------------------------------------------------------------
  // senderAction
  // -------------------------------------------------------------------------

  it('senderAction sends the correct sender_action payload', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const client = makeClient(BASE_ENV);

    await client.senderAction('PSID-1', 'typing_on');

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.sender_action).toBe('typing_on');
    expect(body.recipient).toEqual({ id: 'PSID-1' });
  });

  it('senderAction for mark_seen sends mark_seen', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const client = makeClient(BASE_ENV);

    await client.senderAction('PSID-2', 'mark_seen');

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.sender_action).toBe('mark_seen');
  });

  // -------------------------------------------------------------------------
  // sendTemplate
  // -------------------------------------------------------------------------

  it('sendTemplate builds a generic template body with RESPONSE type', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const client = makeClient(BASE_ENV);

    await client.sendTemplate('PSID-1', [
      { title: 'عباية زرقاء', subtitle: '45.000 د.أ', image_url: 'https://cdn/p1.jpg' },
    ]);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.messaging_type).toBe('RESPONSE');
    expect(body.tag).toBeUndefined();
    expect(body.message.attachment.type).toBe('template');
    expect(body.message.attachment.payload.template_type).toBe('generic');
    expect(body.message.attachment.payload.elements[0].title).toBe('عباية زرقاء');
  });

  // -------------------------------------------------------------------------
  // sendImage
  // -------------------------------------------------------------------------

  it('sendImage builds an image attachment body (RESPONSE, reusable url, no tag)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const client = makeClient(BASE_ENV);

    await client.sendImage('PSID-1', 'https://pub.r2.dev/a.jpeg');

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.messaging_type).toBe('RESPONSE');
    expect(body.tag).toBeUndefined();
    expect(body.recipient).toEqual({ id: 'PSID-1' });
    expect(body.message.attachment.type).toBe('image');
    expect(body.message.attachment.payload).toEqual({
      url: 'https://pub.r2.dev/a.jpeg',
      is_reusable: true,
    });
  });

  it('sendImage throws MessengerSendError on a non-2xx response', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'bad image url' } }),
    });
    const client = makeClient(BASE_ENV);

    await expect(
      client.sendImage('PSID-1', 'https://pub.r2.dev/x.jpeg'),
    ).rejects.toThrow(MessengerSendError);
  });

  // -------------------------------------------------------------------------
  // sendQuickReplies
  // -------------------------------------------------------------------------

  it('sendQuickReplies sends correct quick_replies array', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const client = makeClient(BASE_ENV);

    await client.sendQuickReplies('PSID-1', 'ما هو مقاسك؟', [
      { title: 'S', payload: 'SIZE_S' },
      { title: 'M', payload: 'SIZE_M' },
    ]);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.message.text).toBe('ما هو مقاسك؟');
    expect(body.message.quick_replies).toHaveLength(2);
    expect(body.message.quick_replies[0]).toMatchObject({
      content_type: 'text',
      title: 'S',
      payload: 'SIZE_S',
    });
  });
});
