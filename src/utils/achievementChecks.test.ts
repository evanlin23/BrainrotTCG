import { describe, expect, it } from 'vitest';
import { SETS, isOpenable } from '../content/sets';
import { ACHIEVEMENTS, setCompleteId, setMasterId } from '../data/achievements';
import { getCard } from '../data/cards';
import type { CollectionItem } from '../types';
import { checkCollectionAchievements } from './achievementChecks';

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
});
