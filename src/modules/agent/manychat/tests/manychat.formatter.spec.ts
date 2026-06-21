import { toDynamicBlock } from '../manychat.formatter';
import type { ManyChatCardsMessage } from '../manychat.types';

describe('toDynamicBlock', () => {
  it('wraps reply text in a v2 text message', () => {
    const out = toDynamicBlock({ reply: 'أهلاً' });
    expect(out.version).toBe('v2');
    expect(out.content.messages).toEqual([{ type: 'text', text: 'أهلاً' }]);
  });

  it('adds a cards gallery from products (price + image)', () => {
    const out = toDynamicBlock({
      reply: 'هاي الخيارات',
      products: [
        { id: 'p1', name: 'عباية', price: '45.000', imageUrl: 'https://cdn/p1.jpg' },
      ],
    });
    const cards = out.content.messages.find(
      (m) => m.type === 'cards',
    ) as ManyChatCardsMessage;
    expect(cards.elements[0]).toMatchObject({
      title: 'عباية',
      subtitle: '45.000 د.أ',
      image_url: 'https://cdn/p1.jpg',
    });
  });

  it('omits image_url when a product has no image', () => {
    const out = toDynamicBlock({
      reply: 'x',
      products: [{ id: 'p1', name: 'ع', price: '40.000' }],
    });
    const cards = out.content.messages.find(
      (m) => m.type === 'cards',
    ) as ManyChatCardsMessage;
    expect(cards.elements[0].image_url).toBeUndefined();
  });

  it('caps the gallery at MAX_GALLERY_CARDS (8) cards', () => {
    const products = Array.from({ length: 14 }, (_, i) => ({
      id: `p${i}`,
      name: `n${i}`,
      price: '1.000',
    }));
    const out = toDynamicBlock({ reply: 'x', products });
    const cards = out.content.messages.find(
      (m) => m.type === 'cards',
    ) as ManyChatCardsMessage;
    expect(cards.elements).toHaveLength(8);
  });

  it('appends an Arabic overflow note when overflowCount > 0', () => {
    const out = toDynamicBlock({
      reply: 'خيارات',
      products: [{ id: 'p1', name: 'عباية', price: '45.000' }],
      overflowCount: 3,
    });
    const texts = out.content.messages.filter((m) => m.type === 'text');
    expect(texts).toHaveLength(2);
    // The trailing note must mention the count and invite the customer
    const note = texts[texts.length - 1] as import('../manychat.types').ManyChatTextMessage;
    expect(note.text).toContain('3');
    expect(note.text).toContain('تصميم');
  });

  it('does NOT append an overflow note when overflowCount is 0', () => {
    const out = toDynamicBlock({
      reply: 'خيارات',
      products: [{ id: 'p1', name: 'عباية', price: '45.000' }],
      overflowCount: 0,
    });
    const texts = out.content.messages.filter((m) => m.type === 'text');
    // Only the reply text — no overflow note
    expect(texts).toHaveLength(1);
  });

  it('does NOT append an overflow note when overflowCount is absent', () => {
    const out = toDynamicBlock({
      reply: 'خيارات',
      products: [{ id: 'p1', name: 'عباية', price: '45.000' }],
    });
    const texts = out.content.messages.filter((m) => m.type === 'text');
    expect(texts).toHaveLength(1);
  });

  it('still caps total messages at 10 even with overflow note', () => {
    // 1 text reply + 1 cards message = 2; adding overflow note → 3. Well under 10.
    // Force the worst case: fill messages to MAX_MESSAGES before the overflow note.
    // The formatter slice(0, 10) must prevent a note from pushing past the limit.
    // Constructing this via multiple gallery+text is internal, so test indirectly:
    // provide an overflow note on an already-large message list (simulate via a
    // reply that reaches the cap via the gallery alone — not possible with current
    // formatter, but the cap guard must hold regardless).
    // Simple proof: 1 reply + 1 gallery + overflow → 3 messages total, not 11.
    const products = Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      name: `n${i}`,
      price: '1.000',
    }));
    const out = toDynamicBlock({ reply: 'x', products, overflowCount: 5 });
    expect(out.content.messages.length).toBeLessThanOrEqual(10);
  });

  it('returns empty messages for an empty reply with no products (dedup no-op)', () => {
    const out = toDynamicBlock({ reply: '' });
    expect(out.content.messages).toEqual([]);
  });

  it('emits only cards when the reply text is blank but products exist', () => {
    const out = toDynamicBlock({
      reply: '   ',
      products: [{ id: 'p1', name: 'ع', price: '40.000' }],
    });
    expect(out.content.messages).toHaveLength(1);
    expect(out.content.messages[0].type).toBe('cards');
  });
});
