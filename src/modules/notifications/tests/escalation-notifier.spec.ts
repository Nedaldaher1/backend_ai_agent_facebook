/**
 * Tests for EscalationNotifier.
 *
 * The notifier fetches the customer's name from the Graph API (best-effort)
 * and pushes a composed Arabic message through TelegramClient. `fetch` is
 * mocked for the Graph call; TelegramClient is stubbed. The assertions prove:
 * message content (name/PSID/conversation id/reason), graceful degradation to
 * PSID-only on any profile failure, and the zero-cost skip when Telegram is
 * not configured.
 */

import type { ConfigService } from '@nestjs/config';
import { EscalationNotifier } from '../escalation-notifier';
import type { TelegramClient } from '../telegram.client';

function makeConfig(values: Record<string, string> = {}): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function makeTelegram(enabled = true) {
  const sendMessage: jest.Mock<Promise<void>, [string]> = jest
    .fn<Promise<void>, [string]>()
    .mockResolvedValue(undefined);
  return { enabled, sendMessage } as unknown as TelegramClient & {
    sendMessage: jest.Mock<Promise<void>, [string]>;
  };
}

function profileResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve('error body'),
  } as unknown as Response;
}

const NOTICE = {
  conversationId: 'convo-1',
  psid: 'psid-9',
  reason: 'ai_failure: generate() threw',
};

describe('EscalationNotifier', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  it('includes the Graph profile name, PSID, conversation id and reason', async () => {
    fetchMock.mockResolvedValueOnce(
      profileResponse(200, { first_name: 'سارة', last_name: 'العلي' }),
    );
    const telegram = makeTelegram();
    const notifier = new EscalationNotifier(
      telegram,
      makeConfig({
        MESSENGER_GRAPH_VERSION: 'v25.0',
        MESSENGER_PAGE_ACCESS_TOKEN: 'page-token',
      }),
    );

    await notifier.notify(NOTICE);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://graph.facebook.com/v25.0/psid-9?fields=first_name,last_name',
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer page-token',
    );
    const text = telegram.sendMessage.mock.calls[0][0];
    expect(text).toContain('الزبونة: سارة العلي');
    expect(text).toContain('PSID: psid-9');
    expect(text).toContain('رقم المحادثة: convo-1');
    expect(text).toContain('السبب: ai_failure: generate() threw');
  });

  it.each([
    [
      'Graph returns 400',
      () => profileResponse(400, { error: 'no permission' }),
    ],
    ['Graph rejects', () => Promise.reject(new Error('timeout'))],
  ])('falls back to PSID-only but still sends when %s', async (_label, res) => {
    fetchMock.mockImplementationOnce(() => {
      const r = res();
      return r instanceof Promise ? r : Promise.resolve(r);
    });
    const telegram = makeTelegram();
    const notifier = new EscalationNotifier(
      telegram,
      makeConfig({ MESSENGER_PAGE_ACCESS_TOKEN: 'page-token' }),
    );

    await notifier.notify(NOTICE);

    const text = telegram.sendMessage.mock.calls[0][0];
    expect(text).toContain('الزبونة: غير متوفر');
    expect(text).toContain('PSID: psid-9');
  });

  it('skips the Graph fetch entirely when no page token is set, still sends', async () => {
    const telegram = makeTelegram();
    const notifier = new EscalationNotifier(telegram, makeConfig());

    await notifier.notify(NOTICE);

    expect(fetchMock).not.toHaveBeenCalled();
    const text = telegram.sendMessage.mock.calls[0][0];
    expect(text).toContain('الزبونة: غير متوفر');
  });

  it('does nothing (no Graph call, no send) when Telegram is not configured', async () => {
    const telegram = makeTelegram(false);
    const notifier = new EscalationNotifier(
      telegram,
      makeConfig({ MESSENGER_PAGE_ACCESS_TOKEN: 'page-token' }),
    );

    await notifier.notify(NOTICE);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('propagates Telegram send failures to the caller (who fire-and-forgets)', async () => {
    const telegram = makeTelegram();
    telegram.sendMessage.mockRejectedValueOnce(new Error('403'));
    const notifier = new EscalationNotifier(telegram, makeConfig());

    await expect(notifier.notify(NOTICE)).rejects.toThrow('403');
  });
});
