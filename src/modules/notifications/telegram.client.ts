/**
 * TelegramClient — sends staff notifications through the Telegram Bot API
 * (`sendMessage`).
 *
 * Token/chat-id absent → log and skip (dev-friendly; set the env vars in
 * production to enable). Non-2xx response → throw TelegramSendError (callers
 * decide whether to swallow). Network / timeout failures → throw as-is.
 *
 * Messages are sent as PLAIN TEXT (no parse_mode): the payload embeds
 * user-influenced strings (escalation reasons, customer names) and any
 * Markdown/HTML entity in them would make Telegram reject the message.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Thrown when the Telegram Bot API returns a non-2xx HTTP status. */
export class TelegramSendError extends Error {
  constructor(
    public readonly status: number,
    public readonly apiError: unknown,
  ) {
    super(`Telegram Bot API returned HTTP ${status}`);
    this.name = 'TelegramSendError';
  }
}

@Injectable()
export class TelegramClient {
  private readonly logger = new Logger(TelegramClient.name);
  private readonly botToken: string | undefined;
  private readonly chatId: string | undefined;

  constructor(config: ConfigService) {
    this.botToken = config.get<string>('TELEGRAM_BOT_TOKEN') || undefined;
    this.chatId = config.get<string>('TELEGRAM_CHAT_ID') || undefined;
  }

  /** True when both credentials are configured (feature switch). */
  get enabled(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  /**
   * Send a plain-text message to the configured staff chat.
   *
   * Skips silently (with a warn log) when credentials are absent — set
   * TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable notifications.
   * Throws TelegramSendError on non-2xx so callers can decide to swallow.
   */
  async sendMessage(text: string): Promise<void> {
    if (!this.enabled) {
      this.logger.warn(
        'Telegram notify skipped — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set',
      );
      return;
    }

    // The bot token is part of the Bot API path by design (there is no
    // header-based auth); never log this URL.
    const url = `https://api.telegram.org/bot${this.botToken!}/sendMessage`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      let apiError: unknown;
      try {
        apiError = await res.json();
      } catch {
        apiError = await res.text().catch(() => '(unreadable body)');
      }
      throw new TelegramSendError(res.status, apiError);
    }
  }
}
