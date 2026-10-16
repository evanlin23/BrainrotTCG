import { afterEach, describe, expect, it, vi } from 'vitest';
import * as engine from '../engine';
import { isBigPull, isSpecialReveal, markNew, nextSpecialRevealIndex, revealOrder } from './reveal';

describe('reveal order', () => {
  afterEach(() => vi.restoreAllMocks());
  it('shows the most valuable card last, otherwise pack order', () => {
    const cards = [
      { id: 'a', rarity: 'RARE' as const, isHolo: false },
      { id: 'b', rarity: 'UNCOMMON' as const, isHolo: false },
      { id: 'c', rarity: 'COMMON' as const, isHolo: false },
      { id: 'd', rarity: 'RARE' as const, isHolo: false },
      { id: 'e', rarity: 'COMMON' as const, isHolo: true },
    ];
    expect(revealOrder(cards).map((c) => c.id)).toEqual(['c', 'b', 'a', 'd', 'e']);
    expect(cards.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd', 'e']); // the pack itself is untouched
  });

  it('puts a finish or misprint after plain cards of higher rarity when it is worth more', () => {
    const cards = [
      { id: 'gold', rarity: 'COMMON' as const, isHolo: false, finish: 'GOLD' as const, misprint: false },
      { id: 'diamond', rarity: 'COMMON' as const, isHolo: false, finish: 'DIAMOND' as const, misprint: false },
      { id: 'misprint', rarity: 'COMMON' as const, isHolo: false, finish: null, misprint: true },
      { id: 'plain', rarity: 'COMMON' as const, isHolo: false, finish: null, misprint: false },
      { id: 'epic', rarity: 'EPIC' as const, isHolo: false, finish: null, misprint: false },
    ];
    // 10, 70 (Epic), 400 (Gold), 2,000 (misprint), 10,000 (Diamond)
    expect(revealOrder(cards).map((c) => c.id)).toEqual(['plain', 'epic', 'gold', 'misprint', 'diamond']);
  });

  it('counts finishes and misprints as big pulls', () => {
    expect(isBigPull({ rarity: 'COMMON', isHolo: true })).toBe(false);
    expect(isBigPull({ rarity: 'COMMON', isHolo: false, finish: 'SILVER' })).toBe(true);
    expect(isBigPull({ rarity: 'UNCOMMON', isHolo: false, misprint: true })).toBe(true);
    expect(isBigPull({ rarity: 'RARE', isHolo: false })).toBe(true);
  });

  it('celebrates individual cards worth at least 5,000, including all modifiers', () => {
    expect(isSpecialReveal({ rarity: 'BRAINROT', isHolo: false })).toBe(false);
    expect(isSpecialReveal({ rarity: 'COMMON', isHolo: false, finish: 'PLATINUM' })).toBe(false); // exactly 2,000
    expect(isSpecialReveal({ rarity: 'COMMON', isHolo: false, misprint: true })).toBe(false); // exactly 2,000
    expect(isSpecialReveal({ rarity: 'LEGENDARY', isHolo: true })).toBe(false); // 4,000
    expect(isSpecialReveal({ rarity: 'EPIC', isHolo: false, finish: 'GOLD' })).toBe(false); // Gold Verity: 2,800
    expect(isSpecialReveal({ rarity: 'RARE', isHolo: false, finish: 'GOLD' })).toBe(false); // 1,400
    expect(isSpecialReveal({ rarity: 'COMMON', isHolo: false, finish: 'DIAMOND' })).toBe(true); // 10,000
    expect(isSpecialReveal({ rarity: 'COMMON', isHolo: true, finish: 'SILVER' })).toBe(false); // exactly 2,000
    expect(isSpecialReveal({ rarity: 'RARE', isHolo: true, finish: 'SILVER', misprint: true })).toBe(true);
  });

  // Current rarity/modifier combinations don't make exactly 5,000. Exercise the scoring boundary
  // directly so future card values retain the inclusive rule.
  it.each([[4_999, false], [5_000, true], [5_001, true]] as const)('qualifies a %i-point card: %s', (points, qualifies) => {
    vi.spyOn(engine, 'cardPoints').mockReturnValue(points);
    expect(isSpecialReveal({ rarity: 'COMMON', isHolo: false })).toBe(qualifies);
  });

  it('marks only the first copy of a card the player did not own', () => {
    const owned = new Set(['set/x']);
    const marked = markNew([{ key: 'set/y' }, { key: 'set/x' }, { key: 'set/y' }], (k) => owned.has(k));
    expect(marked.map((c) => c.isNew)).toEqual([true, false, false]);
  });

  it('keeps every unrevealed valuable card in the skip sequence, without replaying seen cards', () => {
    const cards = [
      { rarity: 'COMMON' as const, isHolo: false, isRevealed: false },
      { rarity: 'COMMON' as const, isHolo: false, finish: 'PLATINUM' as const, isRevealed: false }, // exactly 2,000
      { rarity: 'COMMON' as const, isHolo: false, finish: 'DIAMOND' as const, isRevealed: true }, // already seen
      { rarity: 'RARE' as const, isHolo: false, finish: 'PLATINUM' as const, isRevealed: false }, // 7,000
      { rarity: 'COMMON' as const, isHolo: false, finish: 'DIAMOND' as const, isRevealed: false },
    ];
    expect(nextSpecialRevealIndex(cards)).toBe(3);
    const afterPlatinum = cards.map((card, index) => ({ ...card, isRevealed: card.isRevealed || index === 3 }));
    expect(nextSpecialRevealIndex(afterPlatinum)).toBe(4);
    expect(nextSpecialRevealIndex(afterPlatinum.map((card, index) => ({ ...card, isRevealed: card.isRevealed || index === 4 })))).toBe(-1);
    expect(nextSpecialRevealIndex(cards.slice(0, 2))).toBe(-1);
  });
});
