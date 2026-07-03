import { mergeTurns } from '../merge-turns';
import type { IncomingMessage } from '../../agent.service';

const turn = (over: Partial<IncomingMessage>): IncomingMessage => ({
  contactId: 'C1',
  text: 't',
  ...over,
});

describe('mergeTurns', () => {
  it('joins the buffered texts in arrival order', () => {
    const m = mergeTurns([
      turn({ text: 'بدي عباية', externalMessageId: '1' }),
      turn({ text: 'حمراء', externalMessageId: '2' }),
    ]);
    expect(m.text).toBe('بدي عباية\nحمراء');
    expect(m.contactId).toBe('C1');
  });

  it('drops a duplicate externalMessageId within the batch', () => {
    const m = mergeTurns([
      turn({ text: 'a', externalMessageId: 'x' }),
      turn({ text: 'dup', externalMessageId: 'x' }),
      turn({ text: 'b', externalMessageId: 'y' }),
    ]);
    expect(m.text).toBe('a\nb');
  });

  it('takes the last PRESENT image / adRef across the batch', () => {
    const m = mergeTurns([
      turn({
        text: '1',
        lastImageUrl: 'https://a',
        adRef: 'ad1',
        externalMessageId: '1',
      }),
      turn({ text: '2', lastImageUrl: 'https://b', externalMessageId: '2' }),
    ]);
    expect(m.lastImageUrl).toBe('https://b'); // last present
    expect(m.adRef).toBe('ad1'); // 2nd had none → keep the last present
  });

  it('takes the last PRESENT audio url and carries it beside text members', () => {
    const m = mergeTurns([
      turn({ text: '', lastAudioUrl: 'https://cdn/v1.mp4', externalMessageId: '1' }),
      turn({ text: 'وبدي لون أسود', externalMessageId: '2' }),
      turn({ text: '', lastAudioUrl: 'https://cdn/v2.mp4', externalMessageId: '3' }),
    ]);
    expect(m.lastAudioUrl).toBe('https://cdn/v2.mp4'); // last present
    expect(m.text).toBe('وبدي لون أسود'); // audio-only members add no text
  });

  it('carries image and audio together through one merged batch', () => {
    const m = mergeTurns([
      turn({ text: '', lastImageUrl: 'https://cdn/p.jpg', externalMessageId: '1' }),
      turn({ text: '', lastAudioUrl: 'https://cdn/v.mp4', externalMessageId: '2' }),
    ]);
    expect(m.lastImageUrl).toBe('https://cdn/p.jpg');
    expect(m.lastAudioUrl).toBe('https://cdn/v.mp4');
  });

  it('derives a deterministic batch key from the members', () => {
    const items = [
      turn({ externalMessageId: '1' }),
      turn({ externalMessageId: '2' }),
    ];
    expect(mergeTurns(items).externalMessageId).toBe(
      mergeTurns(items).externalMessageId,
    );
    expect(mergeTurns(items).externalMessageId).toContain('batch:C1:');
  });
});
