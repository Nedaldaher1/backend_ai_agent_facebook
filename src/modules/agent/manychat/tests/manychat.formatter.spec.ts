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

  it('caps the gallery at 10 cards', () => {
    const products = Array.from({ length: 14 }, (_, i) => ({
      id: `p${i}`,
      name: `n${i}`,
      price: '1.000',
    }));
    const out = toDynamicBlock({ reply: 'x', products });
    const cards = out.content.messages.find(
      (m) => m.type === 'cards',
    ) as ManyChatCardsMessage;
    expect(cards.elements).toHaveLength(10);
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
