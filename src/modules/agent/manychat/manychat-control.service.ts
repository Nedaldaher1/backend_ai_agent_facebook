/**
 * ManyChatControlService — ManyChat Public API client for conversation control.
 *
 * Covers: custom fields, tags, flow triggers, and subscriber info. Used to
 * mirror the agent's conversation state into ManyChat (ai_state field, human
 * tag, pause/resume flows) so that ManyChat's own automations stay in sync.
 *
 * Design mirrors ManyChatSenderService exactly:
 *  - ConfigService injection, no environment reads elsewhere.
 *  - fetch + AbortSignal.timeout(8000) for every outbound call.
 *  - Best-effort, never-throw: disabled / missing-token / non-2xx / network
 *    errors all log a warning and return false (or null for getInfo). The DB
 *    is the source of truth; ManyChat sync is a best-effort mirror.
 *  - MANYCHAT_ENABLED kill-switch respected on every method.
 *
 * Reuses MANYCHAT_API_TOKEN — one ManyChat account key authorises both the
 * Send API (api.manychat.com/fb/sending/sendContent) and the Public API
 * (api.manychat.com/fb/*). No second token is needed.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ManyChatControlService {
  private readonly logger = new Logger(ManyChatControlService.name);
  private readonly token: string | undefined;
  private readonly base: string;
  private readonly enabled: boolean;
  private readonly aiStateField: string;
  private readonly humanTag: string;
  private readonly pauseFlowId: string | undefined;
  private readonly resumeFlowId: string | undefined;

  constructor(config: ConfigService) {
    this.token = config.get<string>('MANYCHAT_API_TOKEN') || undefined;
    this.base =
      config.get<string>('MANYCHAT_API_BASE') ?? 'https://api.manychat.com';
    this.enabled = config.get<string>('MANYCHAT_ENABLED') !== 'false';
    this.aiStateField =
      config.get<string>('MANYCHAT_AI_STATE_FIELD') ?? 'ai_state';
    this.humanTag =
      config.get<string>('MANYCHAT_HUMAN_TAG') ?? 'ai_human';
    this.pauseFlowId =
      config.get<string>('MANYCHAT_PAUSE_FLOW_ID') || undefined;
    this.resumeFlowId =
      config.get<string>('MANYCHAT_RESUME_FLOW_ID') || undefined;
  }

  // ---------------------------------------------------------------------------
  // Private helper — shared POST logic so each public method is a one-liner.
  // ---------------------------------------------------------------------------

  private async post(path: string, body: unknown): Promise<boolean> {
    if (!this.enabled || !this.token) {
      this.logger.warn(
        'ManyChat control skipped (disabled or MANYCHAT_API_TOKEN missing)',
      );
      return false;
    }

    try {
      const res = await fetch(`${this.base}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        this.logger.warn(
          `ManyChat control POST ${path} returned HTTP ${res.status}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `ManyChat control POST ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API — custom fields
  // ---------------------------------------------------------------------------

  /**
   * Set a single custom field by name for a subscriber.
   * POST /fb/subscriber/setCustomFieldByName
   */
  async setCustomFieldByName(
    subscriberId: string,
    fieldName: string,
    fieldValue: string | number | boolean,
  ): Promise<boolean> {
    return this.post('/fb/subscriber/setCustomFieldByName', {
      subscriber_id: subscriberId,
      field_name: fieldName,
      field_value: fieldValue,
    });
  }

  /**
   * Set multiple custom fields in a single request.
   * POST /fb/subscriber/setCustomFields
   */
  async setCustomFields(
    subscriberId: string,
    fields: Array<{ field_name: string; field_value: unknown }>,
  ): Promise<boolean> {
    return this.post('/fb/subscriber/setCustomFields', {
      subscriber_id: subscriberId,
      fields,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API — tags
  // ---------------------------------------------------------------------------

  /**
   * Add a tag to a subscriber by tag name.
   * POST /fb/subscriber/addTagByName
   */
  async addTagByName(
    subscriberId: string,
    tagName: string,
  ): Promise<boolean> {
    return this.post('/fb/subscriber/addTagByName', {
      subscriber_id: subscriberId,
      tag_name: tagName,
    });
  }

  /**
   * Remove a tag from a subscriber by tag name.
   * POST /fb/subscriber/removeTagByName
   */
  async removeTagByName(
    subscriberId: string,
    tagName: string,
  ): Promise<boolean> {
    return this.post('/fb/subscriber/removeTagByName', {
      subscriber_id: subscriberId,
      tag_name: tagName,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API — flows
  // ---------------------------------------------------------------------------

  /**
   * Trigger a flow for a subscriber.
   * POST /fb/sending/sendFlow
   *
   * Note: ManyChat's field for the flow identifier is `flow_ns`, not `flow_id`.
   * Note: sendFlow does NOT set custom fields — always call setCustomField(s)
   * before triggering a flow that depends on those fields.
   */
  async sendFlow(subscriberId: string, flowId: string): Promise<boolean> {
    return this.post('/fb/sending/sendFlow', {
      subscriber_id: subscriberId,
      flow_ns: flowId,
    });
  }

  // ---------------------------------------------------------------------------
  // Public API — subscriber info
  // ---------------------------------------------------------------------------

  /**
   * Fetch subscriber info. Returns the `data` field from the ManyChat response
   * (or the whole JSON if the response has no `.data`). Returns null on
   * disabled / missing-token / non-2xx / network error. Never throws.
   * GET /fb/subscriber/getInfo?subscriber_id=...
   */
  async getInfo(subscriberId: string): Promise<unknown | null> {
    if (!this.enabled || !this.token) {
      this.logger.warn(
        'ManyChat control skipped (disabled or MANYCHAT_API_TOKEN missing)',
      );
      return null;
    }

    try {
      const url = new URL(`${this.base}/fb/subscriber/getInfo`);
      url.searchParams.set('subscriber_id', subscriberId);

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
        signal: AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        this.logger.warn(
          `ManyChat control GET /fb/subscriber/getInfo returned HTTP ${res.status}`,
        );
        return null;
      }

      const json = (await res.json()) as Record<string, unknown>;
      return 'data' in json ? json['data'] : json;
    } catch (err) {
      this.logger.warn(
        `ManyChat control GET /fb/subscriber/getInfo failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Convenience — orchestrate ManyChat side for a state change
  // ---------------------------------------------------------------------------

  /**
   * Mirror an ai_state transition into ManyChat. Best-effort via
   * Promise.allSettled — individual failures are logged by each method; this
   * method itself never throws.
   *
   * Ordering rationale (per ManyChat docs): sendFlow does NOT set custom
   * fields, so the field is always written first. Once the field write
   * resolves (or fails), the tag and flow ops run concurrently.
   *
   *   'bot'    → remove human tag + (optional) send resume flow
   *   'human'  → add human tag   + (optional) send pause flow
   *   'paused' →                    (optional) send pause flow
   *
   * All state transitions also set the ai_state custom field (first).
   */
  async applyState(
    subscriberId: string,
    state: 'bot' | 'human' | 'paused',
    opts?: { reason?: string },
  ): Promise<void> {
    this.logger.debug(
      `ManyChatControlService.applyState: subscriber=${subscriberId} state=${state}${opts?.reason ? ` reason=${opts.reason}` : ''}`,
    );

    // Step 1: set the field first (sendFlow cannot do this).
    await this.setCustomFieldByName(subscriberId, this.aiStateField, state);

    // Step 2: concurrent tag + flow ops.
    const ops: Promise<boolean>[] = [];

    if (state === 'human') {
      ops.push(this.addTagByName(subscriberId, this.humanTag));
      if (this.pauseFlowId) {
        ops.push(this.sendFlow(subscriberId, this.pauseFlowId));
      }
    } else if (state === 'paused') {
      if (this.pauseFlowId) {
        ops.push(this.sendFlow(subscriberId, this.pauseFlowId));
      }
    } else {
      // state === 'bot'
      ops.push(this.removeTagByName(subscriberId, this.humanTag));
      if (this.resumeFlowId) {
        ops.push(this.sendFlow(subscriberId, this.resumeFlowId));
      }
    }

    if (ops.length > 0) {
      await Promise.allSettled(ops);
    }
  }
}
