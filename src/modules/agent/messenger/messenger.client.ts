/**
 * MessengerClient — sends messages and sender-actions to the Meta Messenger
 * Platform via the Graph API Send API (v25.0).
 *
 * Token/page-id absent → log and skip (dev-friendly; set the env vars in production).
 * Non-2xx Graph response → throw MessengerSendError (callers decide whether to
 * swallow). Network / timeout failures → throw as-is (callers handle).
 *
 * CRITICAL (constraint #3 — no deprecated tags):
 *  - In-window RESPONSE replies:    messaging_type:"RESPONSE", NO tag.
 *  - Human-agent out-of-window:     messaging_type:"MESSAGE_TAG", tag:"HUMAN_AGENT".
 *  - Deprecated / restricted message_tags are forbidden. Only HUMAN_AGENT
 *    is allowed (humanAgent=true path). All other tags are rejected by Meta.
 *
 * Graph API version is read from MESSENGER_GRAPH_VERSION via ConfigService so
 * the pin is a single config entry (constraint #6).
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/** Thrown when the Graph API returns a non-2xx HTTP status. */
export class MessengerSendError extends Error {
  constructor(
    public readonly status: number,
    public readonly graphError: unknown,
  ) {
    super(`Messenger Send API returned HTTP ${status}`);
    this.name = 'MessengerSendError';
  }
}

// ---------------------------------------------------------------------------
// Graph API element types (generic template carousel)
// ---------------------------------------------------------------------------

export interface TemplateButton {
  type: 'postback' | 'web_url';
  title: string;
  payload?: string;
  url?: string;
}

export interface TemplateElement {
  title: string;
  subtitle?: string;
  image_url?: string;
  default_action?: { type: 'web_url'; url: string };
  buttons?: TemplateButton[];
}

/** Sender action values accepted by the Graph API. */
export type SenderAction = 'mark_seen' | 'typing_on' | 'typing_off';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class MessengerClient {
  private readonly logger = new Logger(MessengerClient.name);
  private readonly graphVersion: string;
  private readonly pageId: string | undefined;
  private readonly pageToken: string | undefined;

  constructor(config: ConfigService) {
    this.graphVersion =
      config.get<string>('MESSENGER_GRAPH_VERSION') ?? 'v25.0';
    this.pageId = config.get<string>('MESSENGER_PAGE_ID') || undefined;
    this.pageToken =
      config.get<string>('MESSENGER_PAGE_ACCESS_TOKEN') || undefined;
  }

  /**
   * Send a text message to a PSID.
   *
   * @param psid       Facebook PSID of the recipient.
   * @param text       Message text.
   * @param humanAgent When true, uses MESSAGE_TAG + HUMAN_AGENT (out-of-window
   *                   human-initiated message). When false (default), uses
   *                   RESPONSE with NO tag (in-window agent reply).
   */
  async sendText(psid: string, text: string, humanAgent = false): Promise<void> {
    const body = humanAgent
      ? {
          recipient: { id: psid },
          messaging_type: 'MESSAGE_TAG',
          tag: 'HUMAN_AGENT',
          message: { text },
        }
      : {
          recipient: { id: psid },
          messaging_type: 'RESPONSE',
          message: { text },
        };

    await this.postToSendApi(body);
  }

  /**
   * Send a sender action (mark_seen, typing_on, typing_off) to a PSID.
   * Best-effort — callers may fire-and-forget.
   */
  async senderAction(psid: string, action: SenderAction): Promise<void> {
    await this.postToSendApi({
      recipient: { id: psid },
      sender_action: action,
    });
  }

  /**
   * Send a generic template carousel of product cards (≤10 elements per
   * Meta's hard cap; caller should enforce MAX_GALLERY_CARDS ≤ 8).
   */
  async sendTemplate(psid: string, elements: TemplateElement[]): Promise<void> {
    await this.postToSendApi({
      recipient: { id: psid },
      messaging_type: 'RESPONSE',
      message: {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'generic',
            elements,
          },
        },
      },
    });
  }

  /**
   * Send quick replies alongside a text prompt. Each quick reply is a
   * { title, payload } pair (content_type is always 'text').
   */
  async sendQuickReplies(
    psid: string,
    text: string,
    quickReplies: Array<{ title: string; payload: string }>,
  ): Promise<void> {
    await this.postToSendApi({
      recipient: { id: psid },
      messaging_type: 'RESPONSE',
      message: {
        text,
        quick_replies: quickReplies.map((qr) => ({
          content_type: 'text',
          title: qr.title,
          payload: qr.payload,
        })),
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Build the Send API endpoint URL using the configured version and page id. */
  private buildUrl(): string {
    return `https://graph.facebook.com/${this.graphVersion}/${this.pageId!}/messages`;
  }

  /**
   * POST a body to the Graph API Send endpoint.
   *
   * Skips silently (with a warn log) when credentials are absent — set
   * MESSENGER_PAGE_ID and MESSENGER_PAGE_ACCESS_TOKEN in production.
   *
   * Auth: the Page access token is sent in the Authorization header
   * (`Bearer <token>`) rather than the URL query string. The Graph API
   * accepts OAuth bearer tokens via the Authorization header for all
   * endpoints, which avoids logging the token in access logs and prevents
   * it from appearing in URLs (referrer headers, server logs, error messages).
   *
   * Throws MessengerSendError on non-2xx so callers can decide to swallow.
   */
  private async postToSendApi(body: Record<string, unknown>): Promise<void> {
    if (!this.pageId || !this.pageToken) {
      this.logger.warn(
        'Messenger send skipped — MESSENGER_PAGE_ID or MESSENGER_PAGE_ACCESS_TOKEN not set',
      );
      return;
    }

    const url = this.buildUrl();

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.pageToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      let graphError: unknown;
      try {
        graphError = await res.json();
      } catch {
        graphError = await res.text().catch(() => '(unreadable body)');
      }
      throw new MessengerSendError(res.status, graphError);
    }
  }
}
