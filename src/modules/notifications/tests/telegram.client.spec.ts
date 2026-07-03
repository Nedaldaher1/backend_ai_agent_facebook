/**
 * Tests for TelegramClient.
 *
 * The client POSTs to the Telegram Bot API `sendMessage` endpoint, so `fetch`
 * is mocked. The assertions prove its contract: the request URL/body shape,
 * the skip-when-unconfigured behavior (dev-friendly, mirrors MessengerClient),
 * and the typed error on non-2xx.
 */

import type { ConfigService } from '@nestjs/config';
import { TelegramClient, TelegramSendError } from '../telegram.client';

function makeConfig(values: Record<string, string> = {}): ConfigService {
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

function apiResponse(status = 200, body: unknown = { ok: true }): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve('error body'),
  } as unknown as Response;
}

describe('TelegramClient', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  it('posts the text to sendMessage with the configured token and chat id', async () => {
    fetchMock.mockResolvedValueOnce(apiResponse());
    const client = new TelegramClient(
      makeConfig({
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_CHAT_ID: '-100123',
      }),
    );

    await client.sendMessage('تنبيه تجريبي');

    expect(client.enabled).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botbot-token/sendMessage');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as {
      chat_id: string;
      text: string;
    };
    expect(body).toEqual({ chat_id: '-100123', text: 'تنبيه تجريبي' });
    // Plain text by design — no parse_mode key at all.
    expect('parse_mode' in body).toBe(false);
  });

  it.each([
    ['token missing', { TELEGRAM_CHAT_ID: '-100123' }],
    ['chat id missing', { TELEGRAM_BOT_TOKEN: 'bot-token' }],
    ['both missing', {}],
  ])('skips without fetching when %s', async (_label, env) => {
    const client = new TelegramClient(makeConfig(env));

    await client.sendMessage('ignored');

    expect(client.enabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws TelegramSendError with the status and API body on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce(
      apiResponse(403, { ok: false, description: 'bot was kicked' }),
    );
    const client = new TelegramClient(
      makeConfig({
        TELEGRAM_BOT_TOKEN: 'bot-token',
        TELEGRAM_CHAT_ID: '-100123',
      }),
    );

    const err = await client.sendMessage('x').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TelegramSendError);
    expect((err as TelegramSendError).status).toBe(403);
    expect((err as TelegramSendError).apiError).toEqual({
      ok: false,
      description: 'bot was kicked',
    });
  });
});
