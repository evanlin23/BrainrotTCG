import { describe, expect, it } from 'vitest';
import { xpForLevel, type SetDefinition } from '../engine';
import { CARD_BACKS, PACK_FOILS, TITLES } from './progression';
import { getNextMilestone, type MilestoneStats } from './nextMilestone';

const set = {
  id: 'mock-set',
  name: 'Mock Set',
  cards: Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, name: `Card ${i}`, rarity: 'COMMON' })),
} as unknown as SetDefinition;

const stats = (xp: number, have = 0, holo = 0): MilestoneStats => ({
  xp,
  uniqueBySet: have ? { [set.id]: have } : {},
  holoUniqueBySet: holo ? { [set.id]: holo } : {},
});

/** Enough XP for the last reward there is. */
const everything = xpForLevel(Math.max(...[...TITLES, ...CARD_BACKS, ...PACK_FOILS].map((r) => r.level)));

describe('getNextMilestone', () => {
  it('points a brand-new player at completing the set, since the next cosmetic is two levels away', () => {
    expect(getNextMilestone(stats(0), set)).toMatchObject({
      kind: 'set-complete',
      targetName: 'Mock Set complete',
      detail: '0/4 cards, 4 to go',
      progressText: '0/4',
      progressLabel: '0 of 4',
      progressPct: 0,
      action: { text: 'View binder', target: 'cards' },
    });
  });

  it('prefers a cosmetic that is one level away, from the level floor to the next level, and says it changes no odds', () => {
    // Level 2 starts at 100 XP and level 3 at 300: 200 XP is halfway. Level 3 unlocks the Pack Rat title.
    expect(getNextMilestone(stats(200, 2), set)).toEqual({
      kind: 'cosmetic',
      targetName: 'Pack Rat',
      targetKind: 'title',
      detail: 'Cosmetic, odds unchanged · Lv 3',
      progressText: '50%',
      progressLabel: '50% of the way to level 3',
      progressPct: 50,
      preview: undefined,
      action: { text: 'View rewards', target: 'rewards' },
    });
  });

  it('links choosable rewards (a card back) to selecting them', () => {
    // Level 3 -> Midnight card back at level 4.
    const goal = getNextMilestone(stats(xpForLevel(3)), set);
    expect(goal).toMatchObject({ kind: 'cosmetic', targetName: 'Midnight', targetKind: 'card back', progressPct: 0 });
    expect(goal.action).toEqual({ text: 'Select rewards', target: 'rewards' });
    // A card back has a picture to show; the title before it and the pack foil after have none.
    expect(goal.preview).toEqual({ kind: 'card-back', id: 'midnight' });
    expect(getNextMilestone(stats(xpForLevel(2)), set).preview).toBeUndefined();
    expect(getNextMilestone(stats(xpForLevel(5)), set)).toMatchObject({ targetKind: 'pack foil', preview: undefined });
  });

  it('is never at 100% before the goal is reached', () => {
    const goal = getNextMilestone(stats(xpForLevel(4) - 1), set);
    expect(goal.progressPct).toBe(99);
    expect(getNextMilestone(stats(0, 3), set).progressPct).toBe(75);
    const big = { ...set, cards: Array.from({ length: 400 }, (_, i) => ({ id: `c${i}`, name: 'x', rarity: 'COMMON' })) } as unknown as SetDefinition;
    expect(getNextMilestone({ xp: 0, uniqueBySet: { [set.id]: 399 }, holoUniqueBySet: {} }, big).progressPct).toBe(99);
  });

  it('moves from completing a set to mastering it, counting holos', () => {
    expect(getNextMilestone(stats(0, 3), set)).toMatchObject({ kind: 'set-complete', detail: '3/4 cards, 1 to go' });
    expect(getNextMilestone(stats(0, 4, 1), set)).toMatchObject({
      kind: 'set-master',
      targetName: 'Mock Set master set',
      detail: '1/4 as holos, 3 to go',
      progressPct: 25,
      action: { target: 'cards' },
    });
  });

  it('falls back to the next cosmetic once the set is mastered, even when it is further than a level away', () => {
    const goal = getNextMilestone(stats(xpForLevel(8), 4, 4), set);
    expect(goal).toMatchObject({ kind: 'cosmetic', targetName: 'Gold', targetKind: 'card back', progressLabel: '0% of the way to level 10' });
  });

  it('is done, with nowhere to go, when the set is mastered and every reward is unlocked', () => {
    const goal = getNextMilestone(stats(everything, 4, 4), set);
    expect(goal).toEqual({ kind: 'done', targetName: 'Mock Set mastered', detail: 'Every reward is unlocked', progressText: 'Done', progressLabel: 'Done', progressPct: 100 });
    expect(goal.action).toBeUndefined();
  });

  it('skips set goals for a set with no cards', () => {
    const empty = { ...set, cards: [] } as unknown as SetDefinition;
    expect(getNextMilestone(stats(0), empty)).toMatchObject({ kind: 'cosmetic', targetName: 'Pack Rat' });
    expect(getNextMilestone(stats(everything), empty)).toMatchObject({ kind: 'done', targetName: 'Every reward unlocked' });
  });

  it('counts only the selected set', () => {
    const other: MilestoneStats = { xp: 0, uniqueBySet: { 'another-set': 4 }, holoUniqueBySet: { 'another-set': 4 } };
    expect(getNextMilestone(other, set)).toMatchObject({ kind: 'set-complete', progressText: '0/4' });
  });
});
