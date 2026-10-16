import { describe, expect, it } from 'vitest';
import { packHeadline } from './headline';
import { POKER_HANDS } from './scoring';
import type { Finish, Rarity } from './types';

const card = (cardId: string, rarity: Rarity, extra: { isHolo?: boolean; finish?: Finish; misprint?: boolean; slot?: number } = {}) => ({
  cardId,
  rarity,
  isHolo: false,
  ...extra,
});
// Common Diamond Holo Misprint: 10 × 20 × 1000 × 200.
const a40m = card('A', 'COMMON', { isHolo: true, finish: 'DIAMOND', misprint: true });

describe('packHeadline', () => {
  it('Two Pair with a big modifier card (DESIGN.md fixture)', () => {
    const cards = [a40m, card('A', 'COMMON'), card('B', 'UNCOMMON'), card('B', 'UNCOMMON'), card('C', 'RARE')];
    const h = packHeadline(cards);
    expect(h.total).toBe(400_000_850);
    expect(h.combo).toEqual(POKER_HANDS.TWO_PAIR);
    expect(h.standout).toEqual({ card: cards[0], points: 40_000_000 });
  });

  it('5 of a Kind of equal commons picks the last slot', () => {
    const cards = Array.from({ length: 5 }, () => card('A', 'COMMON'));
    const h = packHeadline(cards);
    expect(h.total).toBe(500_000);
    expect(h.combo).toEqual(POKER_HANDS.FIVE_OF_A_KIND);
    expect(h.standout?.card).toBe(cards[4]);
    expect(h.standout?.points).toBe(10);
  });

  it('ties go to the higher slot', () => {
    const cards = [card('A', 'RARE'), card('B', 'RARE'), card('C', 'COMMON'), card('D', 'UNCOMMON'), card('E', 'COMMON')];
    const h = packHeadline(cards);
    expect(h.total).toBe(110);
    expect(h.combo).toEqual(POKER_HANDS.NO_MATCH);
    expect(h.standout?.card).toBe(cards[1]);
  });

  it('uses an explicit slot over array position for ties', () => {
    const cards = [card('B', 'RARE', { slot: 1 }), card('A', 'RARE', { slot: 0 })];
    expect(packHeadline(cards).standout?.card).toBe(cards[0]);
  });

  it('picks the highest card with no combo', () => {
    const cards = [card('A', 'COMMON'), card('B', 'UNCOMMON'), card('C', 'RARE'), card('D', 'EPIC'), card('E', 'LEGENDARY')];
    const h = packHeadline(cards);
    expect(h.total).toBe(335);
    expect(h.standout).toEqual({ card: cards[4], points: 200 });
  });

  it('a modifier card beats higher rarities', () => {
    const cards = [a40m, card('B', 'UNCOMMON'), card('C', 'RARE'), card('D', 'EPIC'), card('E', 'LEGENDARY')];
    const h = packHeadline(cards);
    expect(h.total).toBe(40_000_325);
    expect(h.combo).toEqual(POKER_HANDS.NO_MATCH);
    expect(h.standout).toEqual({ card: cards[0], points: 40_000_000 });
  });

  it('an empty pack has no standout', () => {
    expect(packHeadline([]).standout).toBeNull();
  });
});
