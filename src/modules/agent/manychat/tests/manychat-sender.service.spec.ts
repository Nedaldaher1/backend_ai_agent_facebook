import { ManyChatSenderService } from '../manychat-sender.service';
import type { ConfigService } from '@nestjs/config';
import type { ManyChatDynamicBlock } from '../manychat.types';

const block: ManyChatDynamicBlock = {
  version: 'v2',
  content: { messages: [{ type: 'text', text: 'hi' }], actions: [], quick_replies: [] },
};

function makeSender(cfg: Record<string, string>): ManyChatSenderService {
  const config = { get: (k: string) => cfg[k] } as unknown as ConfigService;
  return new ManyChatSenderService(config);
}

describe('ManyChatSenderService', () => {
  beforeEach(() => {
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  it('POSTs the block with a bearer token + subscriber id', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200 });
    const sender = makeSender({ MANYCHAT_API_TOKEN: 'tok' });

    const ok = await sender.sendReply('C1', block);

    expect(ok).toBe(true);
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toMatchObject({ subscriber_id: 'C1' });
  });

  it('skips (no fetch) when the token is missing', async () => {
    const sender = makeSender({});
    const ok = await sender.sendReply('C1', block);
    expect(ok).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('is disabled when MANYCHAT_ENABLED=false', async () => {
    const sender = makeSender({ MANYCHAT_API_TOKEN: 'tok', MANYCHAT_ENABLED: 'false' });
    expect(await sender.sendReply('C1', block)).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns false on a non-2xx response (never throws)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 500 });
    const sender = makeSender({ MANYCHAT_API_TOKEN: 'tok' });
    expect(await sender.sendReply('C1', block)).toBe(false);
  });

  it('returns false when fetch rejects (never throws)', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('network'));
    const sender = makeSender({ MANYCHAT_API_TOKEN: 'tok' });
    expect(await sender.sendReply('C1', block)).toBe(false);
  });
});
