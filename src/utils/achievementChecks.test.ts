import { describe, expect, it } from 'vitest';
import { SETS, isOpenable } from '../content/sets';
import { ACHIEVEMENTS, setCompleteId, setMasterId } from '../data/achievements';
import { getCard } from '../data/cards';
import type { CollectionItem } from '../types';
import type { HistoryEntry } from '../game/history';
import { checkCollectionAchievements, checkHistoryAchievements } from './achievementChecks';

const set = SETS.filter(isOpenable)[0];
const own = (holo: boolean, skip = 0): Record<string, CollectionItem> =>
  Object.fromEntries(
    set.cards.slice(skip).map((c) => {
      const key = `${set.id}/${c.id}`;
      return [key, { card: getCard(key)!, normalCount: 1, holoCount: holo ? 1 : 0 }];
    }),
  );
const check = (collection: Record<string, CollectionItem>) => checkCollectionAchievements(collection, { packsOpened: 1, holoCards: {} }, {});

describe('set achievements', () => {
  it('exist for every set you can open', () => {
    for (const s of SETS.filter(isOpenable)) {
      expect(ACHIEVEMENTS.some((a) => a.id === setCompleteId(s.id))).toBe(true);
      expect(ACHIEVEMENTS.some((a) => a.id === setMasterId(s.id))).toBe(true);
    }
    expect(ACHIEVEMENTS.some((a) => a.id === setCompleteId('genesis'))).toBe(false); // archived
  });

  it('unlock when a set is complete, then mastered', () => {
    expect(check(own(false, 1))).not.toContain(setCompleteId(set.id));
    expect(check(own(false))).toContain(setCompleteId(set.id));
    expect(check(own(false))).not.toContain(setMasterId(set.id));
    expect(check(own(true))).toContain(setMasterId(set.id));
  });

  it('does not unlock set completion for zero-copy records', () => {
    const zeroCollection: Record<string, CollectionItem> = Object.fromEntries(
      set.cards.map((c) => {
        const key = `${set.id}/${c.id}`;
        return [key, { card: getCard(key)!, normalCount: 0, holoCount: 0 }];
      }),
    );
    expect(check(zeroCollection)).not.toContain(setCompleteId(set.id));
    expect(check(zeroCollection)).not.toContain(setMasterId(set.id));
    expect(check(zeroCollection)).not.toContain('collect_5');
    expect(check(zeroCollection)).not.toContain('collect_10');
    expect(check(zeroCollection)).not.toContain('complete_collection');
    expect(check(zeroCollection)).not.toContain('first_common');
  });
});

describe('pack achievements from the history', () => {
  const entry = (nonce: number, hand: string, score: number, cards: HistoryEntry['cards'] = null): HistoryEntry => ({
    setId: set.id, setVersion: set.version, nonce, key: 'd99b18ababaa5873', cards, hand, score, openedAt: 1000 + nonce,
  });
  const ids = (history: HistoryEntry[], unlocked = {}) => checkHistoryAchievements(history, unlocked).map((u) => u.id);

  it('count the hand and score of packs without cards', () => {
    const found = ids([entry(0, 'Full House', 1_430), entry(1, '5 of a Kind', 120_000)]);
    expect(found).toEqual(expect.arrayContaining(['two_of_kind', 'three_of_kind', 'full_house', 'two_pair', 'pack_value_100', 'five_of_kind', 'pack_value_10000']));
    expect(found).not.toContain('all_commons_pack');
    expect(new Set(found).size).toBe(found.length);
  });

  it('credit the first pack that earned each one, and skip ones already unlocked', () => {
    const found = checkHistoryAchievements([entry(5, 'Pair', 600), entry(2, 'Pair', 600)], { pack_value_50: 1 });
    expect(found.map((u) => u.id)).toEqual(['two_of_kind']);
    expect(found[0].entry.nonce).toBe(2);
  });

  it('check every card-level achievement when the cards are known', () => {
    const commons = set.cards.filter((c) => c.rarity === 'COMMON');
    const pack = [0, 1, 2, 3, 4].map((i) => ({ id: commons[i % commons.length].id, holo: i === 0 }));
    const found = checkHistoryAchievements([entry(0, 'Pair', 50, pack)], {});
    expect(found.map((u) => u.id)).toEqual(expect.arrayContaining(['all_commons_pack', 'all_same_rarity', 'holo_common', 'pack_value_5']));
    expect(found[0].cards).toHaveLength(5);
  });

  it("wait on card-level achievements for a pack from a set or set version this build doesn't know", () => {
    // A save from a newer build: no rarity to go on, so no all-the-same-rarity pack either (#701).
    const commons = set.cards.filter((c) => c.rarity === 'COMMON');
    const pack = [0, 1, 2, 3, 4].map((i) => ({ id: commons[i % commons.length].id, holo: false }));
    const unknownSet: HistoryEntry = { ...entry(0, 'High Card', 5, pack), setId: 'from-a-newer-build' };
    const unknownVersion: HistoryEntry = { ...entry(1, 'High Card', 5, pack), setVersion: set.version + 100 };
    for (const e of [unknownSet, unknownVersion]) {
      const found = checkHistoryAchievements([e], {});
      expect(found.map((u) => u.id)).not.toContain('all_same_rarity');
      expect(found.map((u) => u.id)).not.toContain('all_commons_pack');
      expect(found.every((u) => u.cards === null)).toBe(true);
    }
  });
});
