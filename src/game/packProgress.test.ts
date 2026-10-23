import { describe, expect, it } from 'vitest';
import { COLLECTIBLE_CARDS, scoreCards } from '../data/cards';
import type { CardWithMeta } from '../types/card';
import { recordPack, type PackProgress } from './packProgress';

const [a, b, c, d] = COLLECTIBLE_CARDS;
let uid = 0;
const copy = (card: typeof a, extra: Partial<CardWithMeta> = {}): CardWithMeta =>
  ({ ...card, uniqueId: uid++, isRevealed: true, isHolo: false, ...extra });
const pack = (cards: CardWithMeta[], counted?: boolean) =>
  ({ cards, counted, setId: a.setId, setVersion: 1, nonce: 7, publicKeyHex: 'ab'.repeat(32) });
const fresh = (): PackProgress => ({ stats: { packsOpened: 0, holoCards: {} }, collection: {}, hallOfFame: {} });

describe('recordPack', () => {
  it('records a first pack: stats, best pack, holos and first_pack', () => {
    const cards = [copy(a, { isHolo: true }), copy(b), copy(c), copy(d), copy(a)];
    const from = fresh();
    const { progress, unlocks } = recordPack(from, pack(cards), {}, 5);
    const { score, points, hand } = scoreCards(cards);
    expect(progress.stats).toMatchObject({
      packsOpened: 1, holoCards: { [a.key]: true },
      highestPackFlexValue: score, highestPackBaseValue: points, highestPackHandName: hand.name,
      highestPackRef: { setId: a.setId, setVersion: 1, nonce: 7 }, highestPackLegacy: false,
    });
    expect(progress.stats.highestPackCards).toBe(cards);
    expect(progress.collection[a.key]).toMatchObject({ normalCount: 1, holoCount: 1 });
    expect(progress.collection[b.key]).toMatchObject({ normalCount: 1, holoCount: 0 });
    expect(unlocks).toContain('first_pack');
    expect(from).toEqual(fresh());
  });

  it('keeps a better best pack and adds to existing collection entries', () => {
    const from = fresh();
    from.stats = { packsOpened: 3, holoCards: {}, highestPackFlexValue: 1e9 };
    const first = recordPack(fresh(), pack([copy(a), copy(b), copy(c), copy(d), copy(b)]), {}).progress;
    from.collection = first.collection;
    const { progress, unlocks } = recordPack(from, pack([copy(a), copy(b), copy(c), copy(d), copy(c)]), { first_pack: 1 });
    expect(progress.stats.packsOpened).toBe(4);
    expect(progress.stats.highestPackFlexValue).toBe(1e9);
    expect(progress.stats.highestPackCards).toBeUndefined();
    expect(progress.collection[b.key].normalCount).toBe(3);
    expect(progress.collection[c.key].normalCount).toBe(3);
    expect(unlocks).not.toContain('first_pack');
  });

  it('tracks finishes, misprints and their extra points', () => {
    const cards = [copy(a, { finish: 'GOLD', misprint: true }), copy(a), copy(b), copy(c), copy(d)];
    const entry = recordPack(fresh(), pack(cards), {}).progress.collection[a.key];
    expect(entry.finishes).toEqual({ GOLD: 1 });
    expect(entry.misprints).toBe(1);
    expect(entry.modifierPoints).toBeGreaterThan(0);
  });

  it('a pack put back on the shelf only adds its cards', () => {
    const from = fresh();
    from.stats = { packsOpened: 1, holoCards: {} };
    const { progress, unlocks } = recordPack(from, pack([copy(a, { isHolo: true }), copy(b), copy(c), copy(d), copy(a)], true), {});
    expect(progress.stats).toBe(from.stats);
    expect(progress.collection[a.key]).toMatchObject({ normalCount: 1, holoCount: 1 });
    expect(unlocks).not.toContain('first_pack');
  });

  it('records the first four of a kind and full house once, at the given time', () => {
    const four = recordPack(fresh(), pack([copy(a), copy(a), copy(a), copy(a), copy(b)]), {}, 11).progress;
    expect(four.hallOfFame.first4OfAKind).toEqual({ achieved: true, date: 11, cardId: a.id });
    expect(four.hallOfFame.firstFullHouse).toBeUndefined();

    const house = recordPack(four, pack([copy(b), copy(b), copy(b), copy(c), copy(c)]), {}, 22).progress;
    expect(house.hallOfFame.first4OfAKind).toEqual(four.hallOfFame.first4OfAKind);
    expect(house.hallOfFame.firstFullHouse).toEqual({ achieved: true, date: 22, cards: { [b.id]: 3, [c.id]: 2 } });

    const again = recordPack(house, pack([copy(d), copy(d), copy(d), copy(d), copy(c)]), {}, 33).progress;
    expect(again.hallOfFame).toEqual(house.hallOfFame);
  });

  it('lists pack milestones after the score unlocks, skipping unlocked ones', () => {
    const { unlocks } = recordPack(fresh(), pack([copy(a), copy(b), copy(c), copy(d), copy(a)]), {});
    const first = unlocks.indexOf('first_pack');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(unlocks.slice(0, first).every((id) => id.startsWith('pack_value_'))).toBe(true);
  });
});
