/**
 * Unit tests for messenger.normalizer.ts — normalizeEvent().
 *
 * Covers:
 *  - All THREE referral shapes (constraint #5):
 *      1. event.message.referral  (Click-to-Messenger ad, first message)
 *      2. event.referral          (returning user / messaging_referrals)
 *      3. event.postback.referral (Get-Started case)
 *  - Referral precedence: message.referral > event.referral > postback.referral
 *  - Image attachment extraction (first image wins)
 *  - Quick-reply folding (payload first, title fallback)
 *  - Postback folding (title + payload)
 *  - Plain text message
 *  - Events with no usable content → null (skipped)
 *  - mid carried as idempotency key
 *  - timestamp carried
 */

import { normalizeEvent } from '../messenger.normalizer';
import type { RawMessagingEvent } from '../messenger.types';

// ---------------------------------------------------------------------------
// Helper: build a minimal messaging event
// ---------------------------------------------------------------------------

function makeEvent(
  overrides: Partial<RawMessagingEvent> = {},
): RawMessagingEvent {
  return {
    sender: { id: 'PSID-123' },
    recipient: { id: 'PAGE-456' },
    timestamp: 1700000000000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

describe('normalizeEvent — plain text', () => {
  it('extracts psid, text, mid, and timestamp from a plain text message', () => {
    const event = makeEvent({
      message: { mid: 'mid-abc', text: 'مرحبا' },
    });
    const result = normalizeEvent(event);
    expect(result).toMatchObject({
      psid: 'PSID-123',
      text: 'مرحبا',
      mid: 'mid-abc',
      timestamp: 1700000000000,
    });
  });

  it('returns null when there is no text, no attachment, and no postback', () => {
    const event = makeEvent({}); // no message, no postback
    expect(normalizeEvent(event)).toBeNull();
  });

  it('returns null when message exists but has no text and no attachments', () => {
    const event = makeEvent({ message: { mid: 'mid-x' } });
    expect(normalizeEvent(event)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Image attachment
// ---------------------------------------------------------------------------

describe('normalizeEvent — image attachment', () => {
  it('extracts imageUrl from the first image attachment', () => {
    const event = makeEvent({
      message: {
        mid: 'mid-img',
        attachments: [
          { type: 'image', payload: { url: 'https://cdn.fb.com/photo.jpg' } },
        ],
      },
    });
    const result = normalizeEvent(event);
    expect(result?.imageUrl).toBe('https://cdn.fb.com/photo.jpg');
  });

  it('ignores non-image attachments and picks the first image', () => {
    const event = makeEvent({
      message: {
        mid: 'mid-multi',
        attachments: [
          { type: 'video', payload: { url: 'https://cdn.fb.com/video.mp4' } },
          { type: 'image', payload: { url: 'https://cdn.fb.com/photo.jpg' } },
          { type: 'image', payload: { url: 'https://cdn.fb.com/other.jpg' } },
        ],
      },
    });
    const result = normalizeEvent(event);
    expect(result?.imageUrl).toBe('https://cdn.fb.com/photo.jpg');
  });

  it('returns a valid InboundMessage (not null) when only an image is present (no text)', () => {
    const event = makeEvent({
      message: {
        mid: 'mid-imgonly',
        attachments: [
          { type: 'image', payload: { url: 'https://cdn.fb.com/photo.jpg' } },
        ],
      },
    });
    const result = normalizeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.imageUrl).toBe('https://cdn.fb.com/photo.jpg');
    expect(result?.text).toBe('');
  });

  it('leaves imageUrl undefined when no image attachment is present', () => {
    const event = makeEvent({
      message: { mid: 'mid-txt', text: 'مرحبا' },
    });
    const result = normalizeEvent(event);
    expect(result?.imageUrl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Audio attachment (voice notes)
// ---------------------------------------------------------------------------

describe('normalizeEvent — audio attachment', () => {
  it('returns a valid InboundMessage (not null) for a voice-only event', () => {
    const event = makeEvent({
      message: {
        mid: 'mid-voice',
        attachments: [
          { type: 'audio', payload: { url: 'https://cdn.fb.com/voice.mp4' } },
        ],
      },
    });
    const result = normalizeEvent(event);
    expect(result).not.toBeNull();
    expect(result?.audioUrl).toBe('https://cdn.fb.com/voice.mp4');
    expect(result?.text).toBe('');
    expect(result?.mid).toBe('mid-voice');
  });

  it('carries audio and image together from a mixed-attachment event', () => {
    const event = makeEvent({
      message: {
        mid: 'mid-mixed',
        attachments: [
          { type: 'audio', payload: { url: 'https://cdn.fb.com/voice.mp4' } },
          { type: 'image', payload: { url: 'https://cdn.fb.com/photo.jpg' } },
        ],
      },
    });
    const result = normalizeEvent(event);
    expect(result?.audioUrl).toBe('https://cdn.fb.com/voice.mp4');
    expect(result?.imageUrl).toBe('https://cdn.fb.com/photo.jpg');
  });

  it('still returns null for a video-only event (unhandled by design)', () => {
    const event = makeEvent({
      message: {
        mid: 'mid-video',
        attachments: [
          { type: 'video', payload: { url: 'https://cdn.fb.com/clip.mp4' } },
        ],
      },
    });
    expect(normalizeEvent(event)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Quick reply
// ---------------------------------------------------------------------------

describe('normalizeEvent — quick_reply', () => {
  it('uses quick_reply.payload as text when payload is present', () => {
    const event = makeEvent({
      message: {
        mid: 'mid-qr',
        text: 'display text',
        quick_reply: { content_type: 'text', payload: 'SIZE_L', title: 'L' },
      },
    });
    const result = normalizeEvent(event);
    expect(result?.text).toBe('SIZE_L');
  });

  it('falls back to quick_reply.title when payload is absent', () => {
    const event = makeEvent({
      message: {
        mid: 'mid-qr-notitle',
        quick_reply: { content_type: 'text', title: 'نعم' },
      },
    });
    const result = normalizeEvent(event);
    expect(result?.text).toBe('نعم');
  });

  it('falls back to message.text when both payload and title are absent', () => {
    const event = makeEvent({
      message: {
        mid: 'mid-qr-fallback',
        text: 'fallback text',
        quick_reply: { content_type: 'text' },
      },
    });
    const result = normalizeEvent(event);
    expect(result?.text).toBe('fallback text');
  });
});

// ---------------------------------------------------------------------------
// Postback
// ---------------------------------------------------------------------------

describe('normalizeEvent — postback', () => {
  it('folds postback title and payload into text (title\npayload)', () => {
    const event = makeEvent({
      postback: { title: 'Get Started', payload: 'GETTING_STARTED' },
    });
    const result = normalizeEvent(event);
    expect(result?.text).toBe('Get Started\nGETTING_STARTED');
  });

  it('uses only title when payload is absent', () => {
    const event = makeEvent({
      postback: { title: 'ابدأ' },
    });
    const result = normalizeEvent(event);
    expect(result?.text).toBe('ابدأ');
  });

  it('uses only payload when title is absent', () => {
    const event = makeEvent({
      postback: { payload: 'MACHINE_CODE' },
    });
    const result = normalizeEvent(event);
    expect(result?.text).toBe('MACHINE_CODE');
  });

  it('returns null when postback has neither title nor payload', () => {
    const event = makeEvent({
      postback: {},
    });
    expect(normalizeEvent(event)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Referral shapes (constraint #5 — all three must work)
// ---------------------------------------------------------------------------

describe('normalizeEvent — referral extraction (constraint #5)', () => {
  // Shape 1: message.referral — Click-to-Messenger ad, first message
  it('shape 1 (message.referral): extracts referral from event.message.referral', () => {
    const event = makeEvent({
      message: {
        mid: 'mid-ref1',
        text: 'مرحبا',
        referral: {
          ref: 'spring-ad-1',
          ad_id: 'ad_111',
          source: 'ADS',
          type: 'OPEN_THREAD',
          ads_context_data: {
            ad_title: 'Spring Collection',
            photo_url: 'https://cdn.fb.com/ad.jpg',
          },
        },
      },
    });
    const result = normalizeEvent(event);
    expect(result?.referral).toMatchObject({
      ref: 'spring-ad-1',
      adId: 'ad_111',
      source: 'ADS',
      type: 'OPEN_THREAD',
      adsContext: {
        ad_title: 'Spring Collection',
        photo_url: 'https://cdn.fb.com/ad.jpg',
      },
    });
  });

  // Shape 2: top-level event.referral — returning user (messaging_referrals)
  it('shape 2 (event.referral): extracts referral from top-level event.referral', () => {
    const event = makeEvent({
      referral: {
        ref: 'returning-ref',
        source: 'SHORTLINK',
        type: 'OPEN_THREAD',
      },
    });
    // A messaging_referrals event has no message, so we need to add a message
    // to avoid the null return (no content).
    const eventWithMessage = {
      ...event,
      message: { mid: 'mid-ref2', text: 'hi' },
    };
    const result = normalizeEvent(eventWithMessage);
    expect(result?.referral).toMatchObject({
      ref: 'returning-ref',
      source: 'SHORTLINK',
      type: 'OPEN_THREAD',
    });
  });

  // Shape 3: postback.referral — Get-Started case
  it('shape 3 (postback.referral): extracts referral from postback.referral', () => {
    const event = makeEvent({
      postback: {
        title: 'Get Started',
        payload: 'GET_STARTED',
        referral: {
          ref: 'getstarted-ref',
          source: 'ADS',
          type: 'OPEN_THREAD',
        },
      },
    });
    const result = normalizeEvent(event);
    expect(result?.referral).toMatchObject({
      ref: 'getstarted-ref',
      source: 'ADS',
      type: 'OPEN_THREAD',
    });
  });

  // Precedence: message.referral wins over event.referral
  it('precedence: message.referral wins over event.referral', () => {
    const event = makeEvent({
      message: {
        mid: 'mid-prec',
        text: 'hi',
        referral: { ref: 'message-ref' },
      },
      referral: { ref: 'event-ref' },
    });
    const result = normalizeEvent(event);
    expect(result?.referral?.ref).toBe('message-ref');
  });

  // Precedence: event.referral wins over postback.referral
  it('precedence: event.referral wins over postback.referral', () => {
    const event = makeEvent({
      message: { mid: 'mid-prec2', text: 'hi' },
      referral: { ref: 'event-ref' },
      postback: {
        payload: 'PB',
        referral: { ref: 'postback-ref' },
      },
    });
    const result = normalizeEvent(event);
    // message.referral is undefined, so event.referral wins
    expect(result?.referral?.ref).toBe('event-ref');
  });

  it('maps referral.ref to the referral.ref field (not adRef — controller does that mapping)', () => {
    const event = makeEvent({
      message: {
        mid: 'mid-adref',
        text: 'مرحبا',
        referral: { ref: 'summer-2024' },
      },
    });
    const result = normalizeEvent(event);
    expect(result?.referral?.ref).toBe('summer-2024');
  });

  it('returns no referral field when no referral is present on the event', () => {
    const event = makeEvent({
      message: { mid: 'mid-noref', text: 'hello' },
    });
    const result = normalizeEvent(event);
    expect(result?.referral).toBeUndefined();
  });

  it('carries ads_context_data inside the adsContext field', () => {
    const event = makeEvent({
      message: {
        mid: 'mid-ctx',
        text: 'hi',
        referral: {
          ref: 'ad-ref',
          ads_context_data: {
            ad_title: 'العباية الصيفية',
            product_id: 'prod-42',
          },
        },
      },
    });
    const result = normalizeEvent(event);
    expect(result?.referral?.adsContext).toMatchObject({
      ad_title: 'العباية الصيفية',
      product_id: 'prod-42',
    });
  });
});

// ---------------------------------------------------------------------------
// Mid and timestamp
// ---------------------------------------------------------------------------

describe('normalizeEvent — mid and timestamp', () => {
  it('carries the mid from the message', () => {
    const event = makeEvent({ message: { mid: 'unique-mid-xyz', text: 'hi' } });
    expect(normalizeEvent(event)?.mid).toBe('unique-mid-xyz');
  });

  it('mid is undefined when there is no message (postback-only)', () => {
    const event = makeEvent({ postback: { title: 'Go', payload: 'GO' } });
    expect(normalizeEvent(event)?.mid).toBeUndefined();
  });

  it('carries the timestamp from the event', () => {
    const event = makeEvent({
      timestamp: 1712345678000,
      message: { mid: 'm', text: 'ts test' },
    });
    expect(normalizeEvent(event)?.timestamp).toBe(1712345678000);
  });
});
