/**
 * Unit tests for messenger.normalizer.ts — extractReferral() export (WS3).
 *
 * extractReferral is exported so the controller can use it for content-less
 * messaging_referrals events. These tests cover the export contract:
 *  - All three referral shapes produce the correct NormalizedReferral.
 *  - Precedence: message.referral > event.referral > postback.referral.
 *  - Returns undefined when no referral is present on any shape.
 *  - adsContext is carried through.
 */

import { extractReferral } from '../messenger.normalizer';
import type { RawMessagingEvent } from '../messenger.types';

function makeEvent(overrides: Partial<RawMessagingEvent> = {}): RawMessagingEvent {
  return {
    sender: { id: 'PSID-1' },
    recipient: { id: 'PAGE-1' },
    timestamp: 1700000000000,
    ...overrides,
  };
}

describe('extractReferral (WS3 export)', () => {
  it('shape 1: extracts from event.message.referral (Click-to-Messenger first message)', () => {
    const event = makeEvent({
      message: {
        mid: 'mid-1',
        referral: { ref: 'ad-1', ad_id: 'ad_111', source: 'ADS', type: 'OPEN_THREAD' },
      },
    });
    const result = extractReferral(event);
    expect(result).toMatchObject({ ref: 'ad-1', adId: 'ad_111', source: 'ADS' });
  });

  it('shape 2: extracts from top-level event.referral (returning user)', () => {
    const event = makeEvent({
      referral: { ref: 'returning-slug', source: 'SHORTLINK', type: 'OPEN_THREAD' },
    });
    const result = extractReferral(event);
    expect(result).toMatchObject({ ref: 'returning-slug', source: 'SHORTLINK' });
  });

  it('shape 3: extracts from event.postback.referral (Get-Started case)', () => {
    const event = makeEvent({
      postback: { title: 'Get Started', payload: 'START', referral: { ref: 'gs-ref' } },
    });
    const result = extractReferral(event);
    expect(result).toMatchObject({ ref: 'gs-ref' });
  });

  it('precedence: message.referral wins over event.referral', () => {
    const event = makeEvent({
      message: { mid: 'mid-p', referral: { ref: 'msg-ref' } },
      referral: { ref: 'event-ref' },
    });
    expect(extractReferral(event)?.ref).toBe('msg-ref');
  });

  it('precedence: event.referral wins over postback.referral', () => {
    const event = makeEvent({
      referral: { ref: 'event-ref' },
      postback: { payload: 'PB', referral: { ref: 'postback-ref' } },
    });
    expect(extractReferral(event)?.ref).toBe('event-ref');
  });

  it('returns undefined when no referral is present on any shape', () => {
    const event = makeEvent({ message: { mid: 'mid-x', text: 'hi' } });
    expect(extractReferral(event)).toBeUndefined();
  });

  it('carries ads_context_data inside adsContext', () => {
    const event = makeEvent({
      message: {
        mid: 'mid-ctx',
        referral: {
          ref: 'r',
          ads_context_data: { ad_title: 'الإعلان', product_id: 'sku-7' },
        },
      },
    });
    const result = extractReferral(event);
    expect(result?.adsContext).toMatchObject({ ad_title: 'الإعلان', product_id: 'sku-7' });
  });

  it('returns an empty-keys object (not undefined) when raw referral exists but has no fields', () => {
    // An empty {} referral → normalizeReferral returns {} (truthy but empty keys).
    const event = makeEvent({
      referral: {},
    });
    const result = extractReferral(event);
    // normalizeReferral({}) returns an empty {} (all fields conditional)
    // which is NOT undefined — the caller (controller) checks Object.keys(referral).length > 0.
    expect(result).toBeDefined();
    expect(Object.keys(result!)).toHaveLength(0);
  });
});
