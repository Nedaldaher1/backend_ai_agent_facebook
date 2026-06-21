/**
 * ManyChatSenderService — pushes an agent reply to a subscriber via the ManyChat
 * Send API (used by the ASYNC debounce path, which ACKs 202 and delivers later).
 *
 * Token-guarded and best-effort: with no `MANYCHAT_API_TOKEN` it logs and skips
 * (so dev never breaks), and any HTTP/network failure is swallowed (the turn was
 * already processed; a delivery retry is the webhook's concern). The exact Send
 * API endpoint + body MUST be confirmed against the ManyChat account before going
 * live — the live call cannot be exercised here.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ManyChatDynamicBlock } from './manychat.types';

@Injectable()
export class ManyChatSenderService {
  private readonly logger = new Logger(ManyChatSenderService.name);
  private readonly token: string | undefined;
  private readonly sendUrl: string;
  private readonly enabled: boolean;

  constructor(config: ConfigService) {
    this.token = config.get<string>('MANYCHAT_API_TOKEN') || undefined;
    this.sendUrl =
      config.get<string>('MANYCHAT_SEND_URL') ??
      'https://api.manychat.com/fb/sending/sendContent';
    this.enabled = config.get<string>('MANYCHAT_ENABLED') !== 'false';
  }

  /**
   * Deliver a Dynamic Block to a subscriber. Returns true on a 2xx send, false
   * when skipped (disabled / no token) or on any failure. Never throws.
   */
  async sendReply(
    contactId: string,
    block: ManyChatDynamicBlock,
  ): Promise<boolean> {
    if (!this.enabled || !this.token) {
      this.logger.warn(
        'ManyChat send skipped (disabled or MANYCHAT_API_TOKEN missing)',
      );
      return false;
    }

    try {
      const res = await fetch(this.sendUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          subscriber_id: contactId,
          data: block,
          message_tag: 'ACCOUNT_UPDATE',
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        this.logger.warn(`ManyChat send returned HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `ManyChat send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }
}
