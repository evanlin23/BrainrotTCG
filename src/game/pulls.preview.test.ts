import { describe, expect, it, vi } from 'vitest';
import { cardPreviewPath, previewOf, previewPath } from './previewLinks';
import { cardPreviewFor, previewFor } from './pulls';
import { revealOrder } from './reveal';

vi.mock('./ticketMiner', () => ({ getTicket: vi.fn(), prefetchTicket: () => undefined }));

type Mods = { isHolo?: boolean; finish?: 'DIAMOND' | 'PLATINUM' | 'GOLD' | 'SILVER' | null; misprint?: boolean };
const pack = (setId: string, ...cards: [string, Mods?][]) =>
  cards.map(([id, mods = {}]) => ({ key: `${setId}/${id}`, rarity: 'COMMON' as const, isHolo: false, ...mods }));
const handPage = (cards: ReturnType<typeof pack>) => previewPath(previewOf(revealOrder(cards))!);

describe("a pack's link", () => {
  it("goes through the headline card's page when its rarest modifier is Gold or rarer", () => {
    expect(previewFor(pack('right-now', ['a', { isHolo: true }], ['b', { finish: 'GOLD' }], ['c', { finish: 'GOLD' }]))).toBe(cardPreviewPath('right-now', 'b', 'GOLD'));
    expect(previewFor(pack('right-now', ['a', { finish: 'GOLD' }], ['b', { misprint: true }]))).toBe(cardPreviewPath('right-now', 'b', 'MISPRINT'));
    expect(previewFor(pack('right-now', ['a', { misprint: true }], ['b', { finish: 'PLATINUM' }]))).toBe(cardPreviewPath('right-now', 'b', 'PLATINUM'));
    expect(previewFor(pack('right-now', ['a'], ['b', { finish: 'DIAMOND', misprint: true }]))).toBe(cardPreviewPath('right-now', 'b', 'DIAMOND'));
  });

  it('keeps the hand page, unchanged, for holo, Silver or nothing', () => {
    for (const cards of [
      pack('right-now', ['a'], ['b'], ['a']),
      pack('right-now', ['a', { isHolo: true }], ['b', { finish: 'SILVER' }], ['b']),
      pack('genesis', ['a', { isHolo: true }], ['b']),
    ]) {
      expect(previewFor(cards)).toBe(handPage(cards));
      expect(previewFor(cards)).toMatch(/^p\/[0-9a-f]{8}\.html$/);
    }
    // Pinned: a hand page code already out in shared links.
    expect(previewFor(pack('right-now', ['jimothy'], ['jimothy'], ['a'], ['a', { isHolo: true }]))).toBe('p/b7c4790b.html');
  });
});

describe("a card's own link", () => {
  it('names its rarest modifier when its set has modifier pages', () => {
    expect(cardPreviewFor('right-now', 'jimothy', { isHolo: true })).toBe(cardPreviewPath('right-now', 'jimothy', 'HOLO'));
    expect(cardPreviewFor('right-now', 'jimothy', { finish: 'SILVER' })).toBe(cardPreviewPath('right-now', 'jimothy', 'SILVER'));
    expect(cardPreviewFor('right-now', 'jimothy', { isHolo: false, finish: null, misprint: false })).toBe('p/9157df58.html');
    expect(cardPreviewFor('genesis', 'x', { isHolo: true })).toBe(cardPreviewPath('genesis', 'x'));
  });
});
