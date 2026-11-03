import { describe, expect, it } from 'vitest';
import { POKER_HANDS } from '../engine';
import { COUNT_UP_MS, PACK_TAKEOVER_KICKER, countUpValue, packTakeoverReason } from './packTakeover';
import type { PackRecord } from './personalRecords';

const best: PackRecord = { kind: 'best', score: 900, previous: 800 };
const setBest: PackRecord = { kind: 'set-best', setId: 'genesis', score: 900, previous: 800 };
const top: PackRecord = { kind: 'top', rank: 2 };

describe('packTakeoverReason (#1293 c)', () => {
  it.each([
    ['Full House', 'FULL_HOUSE'],
    ['4 of a Kind', 'FOUR_OF_A_KIND'],
    ['5 of a Kind', 'FIVE_OF_A_KIND'],
  ] as const)('is earned by a %s, with or without a record', (name, reason) => {
    expect(packTakeoverReason({ name }, null)).toBe(reason);
    expect(packTakeoverReason({ name }, best)).toBe(reason);
  });

  it('names the three hands as the engine\'s combo line does', () => {
    expect(PACK_TAKEOVER_KICKER).toMatchObject({
      FULL_HOUSE: POKER_HANDS.FULL_HOUSE.name,
      FOUR_OF_A_KIND: POKER_HANDS.FOUR_OF_A_KIND.name,
      FIVE_OF_A_KIND: POKER_HANDS.FIVE_OF_A_KIND.name,
      NEW_BEST: 'New best',
    });
  });

  it('is earned by a new best on any hand below a Full House', () => {
    for (const hand of [POKER_HANDS.NO_MATCH, POKER_HANDS.PAIR, POKER_HANDS.TWO_PAIR, POKER_HANDS.THREE_OF_A_KIND]) {
      expect(packTakeoverReason(hand, best)).toBe('NEW_BEST');
    }
  });

  it('is not earned by points alone, a set best, a top rank, or a first pack', () => {
    // The hand is all the helper reads of the pack: a pack's points never reach it.
    expect(packTakeoverReason(POKER_HANDS.THREE_OF_A_KIND, null)).toBeNull();
    expect(packTakeoverReason(POKER_HANDS.TWO_PAIR, setBest)).toBeNull();
    expect(packTakeoverReason(POKER_HANDS.PAIR, top)).toBeNull();
    expect(packTakeoverReason(POKER_HANDS.NO_MATCH, null)).toBeNull();
  });
});

describe('countUpValue', () => {
  it('starts at 0, lands on the target at the end, and never passes it', () => {
    expect(countUpValue(46_500, 0)).toBe(0);
    expect(countUpValue(46_500, -5)).toBe(0);
    expect(countUpValue(46_500, COUNT_UP_MS)).toBe(46_500);
    expect(countUpValue(46_500, COUNT_UP_MS * 10)).toBe(46_500);
  });

  it('climbs in whole numbers, easing out', () => {
    const quarter = countUpValue(1_000, COUNT_UP_MS / 4);
    const half = countUpValue(1_000, COUNT_UP_MS / 2);
    expect(Number.isInteger(quarter)).toBe(true);
    expect(quarter).toBeGreaterThan(0);
    expect(half).toBeGreaterThan(quarter);
    expect(half).toBeLessThan(1_000);
    // Eased out: more than the straight line has climbed by halfway.
    expect(half).toBeGreaterThan(500);
  });

  it('shows a target that is not a positive number as it is', () => {
    expect(countUpValue(0, 100)).toBe(0);
    expect(countUpValue(Number.NaN, 100)).toBeNaN();
  });
});
