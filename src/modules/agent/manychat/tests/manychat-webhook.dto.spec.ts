/**
 * Unit tests for manyChatWebhookSchema (the shared inbound DTO).
 *
 * These lock the exact field contract so that any breaking change to the zod
 * schema (field rename, type change, new required field) is caught immediately.
 * No real network, no real DB — pure zod parsing.
 */

import { manyChatWebhookSchema } from '../manychat-webhook.dto';

describe('manyChatWebhookSchema', () => {
  // ---------------------------------------------------------------------------
  // Valid payloads
  // ---------------------------------------------------------------------------

  it('accepts a full ManyChat Full-Contact-Data-style body', () => {
    const result = manyChatWebhookSchema.safeParse({
      contactId: '12345678',
      text: 'بدي عباية حمرا',
      lastImageUrl: 'https://cdn.example.com/image.jpg',
      adRef: 'spring-sale-2025',
      name: 'ريم الحسن',
      channel: 'messenger',
      messageId: 'msg-abc-123',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({
        contactId: '12345678',
        text: 'بدي عباية حمرا',
        lastImageUrl: 'https://cdn.example.com/image.jpg',
        adRef: 'spring-sale-2025',
        name: 'ريم الحسن',
        channel: 'messenger',
        messageId: 'msg-abc-123',
      });
    }
  });

  it('accepts a minimal body with only contactId and text', () => {
    const result = manyChatWebhookSchema.safeParse({
      contactId: 'C1',
      text: 'مرحبا',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contactId).toBe('C1');
      expect(result.data.text).toBe('مرحبا');
      expect(result.data.lastImageUrl).toBeUndefined();
      expect(result.data.adRef).toBeUndefined();
      expect(result.data.name).toBeUndefined();
      expect(result.data.channel).toBeUndefined();
      expect(result.data.messageId).toBeUndefined();
    }
  });

  it('accepts channel=whatsapp', () => {
    const result = manyChatWebhookSchema.safeParse({
      contactId: 'C1',
      text: 'مرحبا',
      channel: 'whatsapp',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.channel).toBe('whatsapp');
    }
  });

  it('passes through messageId, adRef, and name when present', () => {
    const result = manyChatWebhookSchema.safeParse({
      contactId: 'C2',
      text: 'سلام',
      messageId: 'ext-msg-007',
      adRef: 'eid-2025',
      name: 'نور',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messageId).toBe('ext-msg-007');
      expect(result.data.adRef).toBe('eid-2025');
      expect(result.data.name).toBe('نور');
    }
  });

  // ---------------------------------------------------------------------------
  // Missing required fields
  // ---------------------------------------------------------------------------

  it('rejects a body that is missing contactId', () => {
    const result = manyChatWebhookSchema.safeParse({
      text: 'مرحبا',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toContain('contactId');
    }
  });

  it('rejects a body that is missing text', () => {
    const result = manyChatWebhookSchema.safeParse({
      contactId: 'C1',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toContain('text');
    }
  });

  // ---------------------------------------------------------------------------
  // Empty strings (min(1) enforcement)
  // ---------------------------------------------------------------------------

  it('rejects an empty contactId string', () => {
    const result = manyChatWebhookSchema.safeParse({
      contactId: '',
      text: 'مرحبا',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toContain('contactId');
    }
  });

  it('rejects an empty text string', () => {
    const result = manyChatWebhookSchema.safeParse({
      contactId: 'C1',
      text: '',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toContain('text');
    }
  });

  // ---------------------------------------------------------------------------
  // lastImageUrl — must be a valid URL when provided
  // ---------------------------------------------------------------------------

  it('rejects a non-URL lastImageUrl', () => {
    const result = manyChatWebhookSchema.safeParse({
      contactId: 'C1',
      text: 'مرحبا',
      lastImageUrl: 'not-a-url',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toContain('lastImageUrl');
    }
  });

  it('rejects an empty string for lastImageUrl (fails URL check)', () => {
    const result = manyChatWebhookSchema.safeParse({
      contactId: 'C1',
      text: 'مرحبا',
      lastImageUrl: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid https URL for lastImageUrl', () => {
    const result = manyChatWebhookSchema.safeParse({
      contactId: 'C1',
      text: 'مرحبا',
      lastImageUrl: 'https://assets.example.com/photo.jpg',
    });
    expect(result.success).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // channel — must be 'messenger' | 'whatsapp'
  // ---------------------------------------------------------------------------

  it('rejects an invalid channel value', () => {
    const result = manyChatWebhookSchema.safeParse({
      contactId: 'C1',
      text: 'مرحبا',
      channel: 'telegram',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toContain('channel');
    }
  });

  it('rejects a numeric channel value', () => {
    const result = manyChatWebhookSchema.safeParse({
      contactId: 'C1',
      text: 'مرحبا',
      channel: 1,
    });
    expect(result.success).toBe(false);
  });
});
