/**
 * Unit tests for messenger.formatter.ts — formatMessengerReply().
 *
 * Covers:
 *  - Text-only reply → one text payload.
 *  - Text + products → text + template carousel.
 *  - Overflow note appended when overflowCount > 0.
 *  - No overflow note when overflowCount is 0 or absent.
 *  - Gallery cap: MAX_GALLERY_CARDS (8) — more products are sliced.
 *  - Empty reply with no products → empty array (dedup no-op).
 *  - Products without images → no image_url on elements.
 *  - MAX_GALLERY_CARDS is defined in messenger.formatter (8, the canonical value).
 */

import {
  formatMessengerReply,
  MAX_GALLERY_CARDS,
} from '../messenger.formatter';

describe('formatMessengerReply', () => {
  // -------------------------------------------------------------------------
  // Text only
  // -------------------------------------------------------------------------

  it('returns a single text payload for a text-only reply', () => {
    const payloads = formatMessengerReply({ reply: 'أهلاً' });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({ kind: 'text', text: 'أهلاً' });
  });

  it('trims the reply text', () => {
    const payloads = formatMessengerReply({ reply: '   أهلاً   ' });
    expect(payloads[0]).toMatchObject({ kind: 'text', text: 'أهلاً' });
  });

  // -------------------------------------------------------------------------
  // Text + carousel
  // -------------------------------------------------------------------------

  it('returns text + template when products are present', () => {
    const payloads = formatMessengerReply({
      reply: 'خيارات',
      products: [
        {
          id: 'p1',
          name: 'عباية زرقاء',
          price: '45.000',
          imageUrl: 'https://cdn/p1.jpg',
        },
      ],
    });
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ kind: 'text', text: 'خيارات' });
    expect(payloads[1].kind).toBe('template');
    if (payloads[1].kind === 'template') {
      expect(payloads[1].elements[0]).toMatchObject({
        title: 'عباية زرقاء',
        subtitle: '45.000 د.أ',
        image_url: 'https://cdn/p1.jpg',
      });
    }
  });

  it('omits image_url from element when product has no imageUrl', () => {
    const payloads = formatMessengerReply({
      reply: 'خيارات',
      products: [{ id: 'p1', name: 'عباية', price: '40.000' }],
    });
    const tpl = payloads.find((p) => p.kind === 'template');
    expect(tpl).toBeDefined();
    if (tpl?.kind === 'template') {
      expect(tpl.elements[0].image_url).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // Overflow note
  // -------------------------------------------------------------------------

  it('appends a text payload overflow note when overflowCount > 0', () => {
    const payloads = formatMessengerReply({
      reply: 'خيارات',
      products: [{ id: 'p1', name: 'عباية', price: '45.000' }],
      overflowCount: 3,
    });
    const texts = payloads.filter((p) => p.kind === 'text');
    expect(texts).toHaveLength(2);
    const note = texts[texts.length - 1];
    if (note.kind === 'text') {
      expect(note.text).toContain('3');
      expect(note.text).toContain('تصميم');
    }
  });

  it('does NOT append an overflow note when overflowCount is 0', () => {
    const payloads = formatMessengerReply({
      reply: 'خيارات',
      products: [{ id: 'p1', name: 'عباية', price: '45.000' }],
      overflowCount: 0,
    });
    const texts = payloads.filter((p) => p.kind === 'text');
    expect(texts).toHaveLength(1);
  });

  it('does NOT append an overflow note when overflowCount is absent', () => {
    const payloads = formatMessengerReply({
      reply: 'خيارات',
      products: [{ id: 'p1', name: 'عباية', price: '45.000' }],
    });
    const texts = payloads.filter((p) => p.kind === 'text');
    expect(texts).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Gallery cap
  // -------------------------------------------------------------------------

  it('caps the carousel at MAX_GALLERY_CARDS elements', () => {
    const products = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i}`,
      name: `عباية ${i}`,
      price: '45.000',
    }));
    const payloads = formatMessengerReply({ reply: 'خيارات', products });
    const tpl = payloads.find((p) => p.kind === 'template');
    if (tpl?.kind === 'template') {
      expect(tpl.elements).toHaveLength(MAX_GALLERY_CARDS);
    }
  });

  // -------------------------------------------------------------------------
  // Empty / dedup no-op
  // -------------------------------------------------------------------------

  it('returns empty array for an empty reply with no products (dedup no-op)', () => {
    expect(formatMessengerReply({ reply: '' })).toHaveLength(0);
  });

  it('returns only the template when reply text is blank but products exist', () => {
    const payloads = formatMessengerReply({
      reply: '   ',
      products: [{ id: 'p1', name: 'عباية', price: '45.000' }],
    });
    expect(payloads).toHaveLength(1);
    expect(payloads[0].kind).toBe('template');
  });

  // -------------------------------------------------------------------------
  // Shared cap invariant
  // -------------------------------------------------------------------------

  it('MAX_GALLERY_CARDS is 8 (the canonical Messenger gallery cap)', () => {
    expect(MAX_GALLERY_CARDS).toBe(8);
  });
});
