/**
 * EscalationNotifier — pushes a Telegram alert to the staff chat whenever the
 * agent hands a conversation off to a human, so an employee notices without
 * watching the inbox.
 *
 * The customer's name is NOT stored anywhere (the Messenger webhook never
 * carries it), so it is fetched best-effort from the Graph API profile
 * endpoint at notify time. Any profile-fetch failure (missing token, missing
 * permission, expired PSID, timeout) degrades to a PSID-only message — the
 * notification itself must never be lost because of the name lookup.
 *
 * The Graph call lives here (not in MessengerClient) on purpose: this module
 * is imported by ConversationsModule, while MessengerClient is provided by
 * AgentModule which itself imports ConversationsModule — reusing it would
 * create a module cycle. Both read the same MESSENGER_* env vars.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramClient } from './telegram.client';

/** Facts about an escalation the staff message is built from. */
export interface EscalationNotice {
  conversationId: string;
  psid: string;
  reason: string;
}

@Injectable()
export class EscalationNotifier {
  private readonly logger = new Logger(EscalationNotifier.name);
  private readonly graphVersion: string;
  private readonly pageToken: string | undefined;

  constructor(
    private readonly telegram: TelegramClient,
    config: ConfigService,
  ) {
    this.graphVersion =
      config.get<string>('MESSENGER_GRAPH_VERSION') ?? 'v25.0';
    this.pageToken =
      config.get<string>('MESSENGER_PAGE_ACCESS_TOKEN') || undefined;
  }

  /**
   * Send the staff alert for one escalation. Resolves when the Telegram call
   * finishes; rejects on send failure (callers fire-and-forget with a catch).
   * No-ops when Telegram is not configured — skip before the Graph lookup so
   * a disabled feature costs zero external calls.
   */
  async notify(notice: EscalationNotice): Promise<void> {
    if (!this.telegram.enabled) {
      this.logger.warn(
        `escalation notification skipped for ${notice.conversationId} — Telegram not configured`,
      );
      return;
    }

    const name = await this.fetchCustomerName(notice.psid);

    const text = [
      'تنبيه: تم تحويل محادثة إلى موظف',
      `الزبونة: ${name ?? 'غير متوفر'}`,
      `PSID: ${notice.psid}`,
      `رقم المحادثة: ${notice.conversationId}`,
      `السبب: ${notice.reason}`,
    ].join('\n');

    await this.telegram.sendMessage(text);
    this.logger.log(
      `escalation notification sent for conversation ${notice.conversationId}`,
    );
  }

  /**
   * Best-effort Graph API profile lookup (`first_name last_name` for a PSID).
   * Returns undefined on ANY failure — Graph commonly answers 400 when the
   * page token lacks profile fields or the user withheld consent.
   */
  private async fetchCustomerName(psid: string): Promise<string | undefined> {
    if (!this.pageToken) {
      return undefined;
    }
    try {
      const url = `https://graph.facebook.com/${this.graphVersion}/${psid}?fields=first_name,last_name`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.pageToken}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        this.logger.warn(
          `Graph profile fetch for ${psid} returned HTTP ${res.status} — falling back to PSID-only`,
        );
        return undefined;
      }
      const profile = (await res.json()) as {
        first_name?: string;
        last_name?: string;
      };
      const name = [profile.first_name, profile.last_name]
        .filter(Boolean)
        .join(' ')
        .trim();
      return name || undefined;
    } catch (err) {
      this.logger.warn(
        `Graph profile fetch for ${psid} failed: ${String(err)} — falling back to PSID-only`,
      );
      return undefined;
    }
  }
}
