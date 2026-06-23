/**
 * Unit tests for messenger-webhook.dto.ts schemas.
 *
 * Covers:
 *  - messengerWebhookBodySchema: valid body accepted.
 *  - entry array cap (.max(50)): over-cap rejected.
 *  - messaging array cap (.max(100)): over-cap rejected.
 *  - string field caps (ids, text, urls, ref).
 *  - messengerVerifyQuerySchema: valid query accepted.
 *  - messengerVerifyQuerySchema: missing required fields rejected.
 *  - messengerVerifyQuerySchema: oversized field rejected.
 *  - passthrough: extra unknown fields on events are preserved.
 */

import {
  messengerWebhookBodySchema,
  messengerVerifyQuerySchema,
} from '../messenger-webhook.dto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMinimalEvent(mid = 'mid-1') {
  return {
    sender: { id: 'PSID-1' },
    recipient: { id: 'PAGE-1' },
    timestamp: 1700000000000,
    message: { mid, text: 'مرحبا' },
  };
}

function makeBody(entryCount = 1, messagingCount = 1) {
  return {
    object: 'page',
    entry: Array.from({ length: entryCount }, (_, i) => ({
      id: `PAGE-${i}`,
      time: Date.now(),
      messaging: Array.from({ length: messagingCount }, (_, j) =>
        makeMinimalEvent(`mid-${i}-${j}`),
      ),
    })),
  };
}

// ---------------------------------------------------------------------------
// messengerWebhookBodySchema — valid body
// ---------------------------------------------------------------------------

describe('messengerWebhookBodySchema', () => {
  it('accepts a minimal valid body with one entry and one messaging event', () => {
    const result = messengerWebhookBodySchema.safeParse(makeBody(1, 1));
    expect(result.success).toBe(true);
  });

  it('accepts a body at the entry cap (50 entries)', () => {
    const result = messengerWebhookBodySchema.safeParse(makeBody(50, 1));
    expect(result.success).toBe(true);
  });

  it('accepts a body at the messaging cap (100 events in one entry)', () => {
    const result = messengerWebhookBodySchema.safeParse(makeBody(1, 100));
    expect(result.success).toBe(true);
  });

  // -------------------------------------------------------------------------
  // DoS / fan-out caps (hardening item 1)
  // -------------------------------------------------------------------------

  it('rejects an entry array exceeding the .max(50) cap', () => {
    const result = messengerWebhookBodySchema.safeParse(makeBody(51, 1));
    expect(result.success).toBe(false);
    if (!result.success) {
      // zod path: ['entry']
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p.startsWith('entry'))).toBe(true);
    }
  });

  it('rejects a messaging array exceeding the .max(100) cap', () => {
    const result = messengerWebhookBodySchema.safeParse(makeBody(1, 101));
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p.includes('messaging'))).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // String caps on message fields
  // -------------------------------------------------------------------------

  it('rejects a message.text longer than 4000 chars', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'P1',
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'PSID-1' },
              recipient: { id: 'PAGE-1' },
              timestamp: Date.now(),
              message: { mid: 'mid-x', text: 'a'.repeat(4001) },
            },
          ],
        },
      ],
    };
    const result = messengerWebhookBodySchema.safeParse(body);
    expect(result.success).toBe(false);
  });

  it('rejects a sender id longer than 64 chars', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'P1',
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'x'.repeat(65) },
              recipient: { id: 'PAGE-1' },
              timestamp: Date.now(),
              message: { mid: 'mid-x', text: 'hi' },
            },
          ],
        },
      ],
    };
    const result = messengerWebhookBodySchema.safeParse(body);
    expect(result.success).toBe(false);
  });

  it('rejects a referral.ref longer than 512 chars', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'P1',
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'PSID-1' },
              recipient: { id: 'PAGE-1' },
              timestamp: Date.now(),
              message: {
                mid: 'mid-x',
                text: 'hi',
                referral: { ref: 'r'.repeat(513) },
              },
            },
          ],
        },
      ],
    };
    const result = messengerWebhookBodySchema.safeParse(body);
    expect(result.success).toBe(false);
  });

  // -------------------------------------------------------------------------
  // passthrough — unknown fields preserved
  // -------------------------------------------------------------------------

  it('passes through unknown fields on messaging events (Meta adds fields over time)', () => {
    const body = {
      object: 'page',
      entry: [
        {
          id: 'P1',
          time: Date.now(),
          messaging: [
            {
              sender: { id: 'PSID-1' },
              recipient: { id: 'PAGE-1' },
              timestamp: Date.now(),
              message: { mid: 'mid-x', text: 'hi' },
              meta_future_field: 'some_value',
            },
          ],
        },
      ],
    };
    const result = messengerWebhookBodySchema.safeParse(body);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        (result.data.entry[0].messaging[0] as Record<string, unknown>)
          .meta_future_field,
      ).toBe('some_value');
    }
  });
});

// ---------------------------------------------------------------------------
// messengerVerifyQuerySchema — GET hub verification
// ---------------------------------------------------------------------------

describe('messengerVerifyQuerySchema', () => {
  it('accepts a valid verification query', () => {
    const result = messengerVerifyQuerySchema.safeParse({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'my-verify-token',
      'hub.challenge': '1234567890',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data['hub.mode']).toBe('subscribe');
      expect(result.data['hub.challenge']).toBe('1234567890');
    }
  });

  it('rejects when hub.mode is missing', () => {
    const result = messengerVerifyQuerySchema.safeParse({
      'hub.verify_token': 'token',
      'hub.challenge': 'challenge',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when hub.verify_token is missing', () => {
    const result = messengerVerifyQuerySchema.safeParse({
      'hub.mode': 'subscribe',
      'hub.challenge': 'challenge',
    });
    expect(result.success).toBe(false);
  });

  it('rejects when hub.challenge is missing', () => {
    const result = messengerVerifyQuerySchema.safeParse({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'token',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a hub.mode longer than 64 chars', () => {
    const result = messengerVerifyQuerySchema.safeParse({
      'hub.mode': 's'.repeat(65),
      'hub.verify_token': 'token',
      'hub.challenge': 'challenge',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a hub.verify_token longer than 512 chars', () => {
    const result = messengerVerifyQuerySchema.safeParse({
      'hub.mode': 'subscribe',
      'hub.verify_token': 't'.repeat(513),
      'hub.challenge': 'challenge',
    });
    expect(result.success).toBe(false);
  });
});
