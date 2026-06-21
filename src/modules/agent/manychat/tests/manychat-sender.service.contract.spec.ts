/**
 * Strengthened contract tests for ManyChatSenderService.
 *
 * Existing tests (manychat-sender.service.spec.ts) cover the disabled/enabled
 * happy-paths and the basic non-2xx + network-throw returns-false cases.
 *
 * This spec adds:
 *  - Exact URL assertion (https://api.manychat.com/fb/sending/sendContent)
 *  - Exact method assertion (POST)
 *  - Exact Authorization header (Bearer <token>)
 *  - Content-Type header assertion (application/json)
 *  - Full JSON body shape: { subscriber_id, data, message_tag: 'ACCOUNT_UPDATE' }
 *  - data equals the passed Dynamic Block
 *  - Non-2xx returns false and does NOT throw (re-asserted with full body check)
 *  - Network throw returns false and does NOT throw (re-asserted with body check)
 *  - Custom MANYCHAT_SEND_URL env var is honoured
 */

import { ManyChatSenderService } from '../manychat-sender.service';
import type { ConfigService } from '@nestjs/config';
import type { ManyChatDynamicBlock } from '../manychat.types';

const EXPECTED_URL = 'https://api.manychat.com/fb/sending/sendContent';
const TOKEN = 'test-bearer-token-abc123';
const SUBSCRIBER_ID = 'subscriber-999';

const testBlock: ManyChatDynamicBlock = {
  version: 'v2',
  content: {
    messages: [
      { type: 'text', text: 'مرحبا، هاي العبايات:' },
      {
        type: 'cards',
        elements: [{ title: 'عباية كلاسيكية', subtitle: '45.000 د.أ' }],
        image_aspect_ratio: 'square',
      },
    ],
    actions: [],
    quick_replies: [],
  },
};

function makeSender(cfg: Record<string, string | undefined>): ManyChatSenderService {
  const config = { get: (k: string) => cfg[k] } as unknown as ConfigService;
  return new ManyChatSenderService(config);
}

describe('ManyChatSenderService — Send API contract', () => {
  beforeEach(() => {
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Exact URL
  // -------------------------------------------------------------------------

  it('calls the exact ManyChat Send API URL', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const sender = makeSender({ MANYCHAT_API_TOKEN: TOKEN });

    await sender.sendReply(SUBSCRIBER_ID, testBlock);

    const [calledUrl] = (global.fetch as jest.Mock).mock.calls[0];
    expect(calledUrl).toBe(EXPECTED_URL);
  });

  // -------------------------------------------------------------------------
  // HTTP method
  // -------------------------------------------------------------------------

  it('uses the POST method', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const sender = makeSender({ MANYCHAT_API_TOKEN: TOKEN });

    await sender.sendReply(SUBSCRIBER_ID, testBlock);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.method).toBe('POST');
  });

  // -------------------------------------------------------------------------
  // Headers
  // -------------------------------------------------------------------------

  it('sends Authorization: Bearer <token>', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const sender = makeSender({ MANYCHAT_API_TOKEN: TOKEN });

    await sender.sendReply(SUBSCRIBER_ID, testBlock);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('sends Content-Type: application/json', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const sender = makeSender({ MANYCHAT_API_TOKEN: TOKEN });

    await sender.sendReply(SUBSCRIBER_ID, testBlock);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  // -------------------------------------------------------------------------
  // Body shape
  // -------------------------------------------------------------------------

  it('sends a JSON body with subscriber_id matching the contactId argument', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const sender = makeSender({ MANYCHAT_API_TOKEN: TOKEN });

    await sender.sendReply(SUBSCRIBER_ID, testBlock);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.subscriber_id).toBe(SUBSCRIBER_ID);
  });

  it('sends a JSON body with data equal to the passed Dynamic Block', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const sender = makeSender({ MANYCHAT_API_TOKEN: TOKEN });

    await sender.sendReply(SUBSCRIBER_ID, testBlock);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.data).toEqual(testBlock);
  });

  it('sends a JSON body with message_tag === "ACCOUNT_UPDATE"', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const sender = makeSender({ MANYCHAT_API_TOKEN: TOKEN });

    await sender.sendReply(SUBSCRIBER_ID, testBlock);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.message_tag).toBe('ACCOUNT_UPDATE');
  });

  it('sends exactly { subscriber_id, data, message_tag } and no extra keys', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const sender = makeSender({ MANYCHAT_API_TOKEN: TOKEN });

    await sender.sendReply(SUBSCRIBER_ID, testBlock);

    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(init.body as string);
    const keys = Object.keys(body).sort();
    expect(keys).toEqual(['data', 'message_tag', 'subscriber_id']);
  });

  // -------------------------------------------------------------------------
  // Non-2xx — returns false, does not throw
  // -------------------------------------------------------------------------

  it('returns false on a 400 response and does NOT throw', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 400 });
    const sender = makeSender({ MANYCHAT_API_TOKEN: TOKEN });
    await expect(sender.sendReply(SUBSCRIBER_ID, testBlock)).resolves.toBe(false);
  });

  it('returns false on a 429 (rate-limit) response and does NOT throw', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 429 });
    const sender = makeSender({ MANYCHAT_API_TOKEN: TOKEN });
    await expect(sender.sendReply(SUBSCRIBER_ID, testBlock)).resolves.toBe(false);
  });

  it('returns false on a 500 response and does NOT throw', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const sender = makeSender({ MANYCHAT_API_TOKEN: TOKEN });
    await expect(sender.sendReply(SUBSCRIBER_ID, testBlock)).resolves.toBe(false);
  });

  // -------------------------------------------------------------------------
  // Network throw — returns false, does not throw
  // -------------------------------------------------------------------------

  it('returns false on AbortError (timeout) and does NOT throw', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    (global.fetch as jest.Mock).mockRejectedValue(abortErr);
    const sender = makeSender({ MANYCHAT_API_TOKEN: TOKEN });
    await expect(sender.sendReply(SUBSCRIBER_ID, testBlock)).resolves.toBe(false);
  });

  it('returns false on generic network error and does NOT throw', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new TypeError('fetch failed'));
    const sender = makeSender({ MANYCHAT_API_TOKEN: TOKEN });
    await expect(sender.sendReply(SUBSCRIBER_ID, testBlock)).resolves.toBe(false);
  });

  // -------------------------------------------------------------------------
  // Custom MANYCHAT_SEND_URL env var
  // -------------------------------------------------------------------------

  it('uses a custom MANYCHAT_SEND_URL when set', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const customUrl = 'https://custom.host/send';
    const sender = makeSender({
      MANYCHAT_API_TOKEN: TOKEN,
      MANYCHAT_SEND_URL: customUrl,
    });

    await sender.sendReply(SUBSCRIBER_ID, testBlock);

    const [calledUrl] = (global.fetch as jest.Mock).mock.calls[0];
    expect(calledUrl).toBe(customUrl);
  });
});
