import { describe, expect, it } from 'vitest';
import { CARD_BACKS, COLLECTION_MILESTONES, PACK_FOILS, TITLES, collectionMilestone, levelUpLine, nextReward, nextRewards, setProgress, titleFor, usable } from './progression';

describe('progression', () => {
  it('starts everyone with a title, a card back and a pack foil', () => {
    for (const rewards of [TITLES, CARD_BACKS, PACK_FOILS]) {
      expect(rewards[0].level).toBe(1);
      expect([...rewards].sort((a, b) => a.level - b.level)).toEqual(rewards); // in level order
      expect(new Set(rewards.map((r) => r.id)).size).toBe(rewards.length);
    }
  });

  it('gives the highest title reached', () => {
    expect(titleFor(1)).toBe('Fresh Pull');
    expect(titleFor(4)).toBe('Pack Rat');
    expect(titleFor(99)).toBe('Brainrot Royalty');
  });

  it('names the next unlock', () => {
    expect(nextReward(1)).toMatchObject({ level: 3, kind: 'title' });
    expect(nextReward(3)).toMatchObject({ level: 4, kind: 'card back', name: 'Midnight' });
    expect(nextReward(30)).toBeUndefined();
  });

  it('lets a choosable cosmetic lead where a title shares its level (#212)', () => {
    // Level 12 holds Meme Historian (title) and Gold foil; level 20 holds Aura Farmer (title) and Prismatic (card back).
    expect(nextReward(11)).toMatchObject({ level: 12, kind: 'pack foil', name: 'Gold foil', id: 'gold' });
    expect(nextReward(19)).toMatchObject({ level: 20, kind: 'card back', name: 'Prismatic', id: 'prism' });
    expect(nextRewards(11).map((r) => [r.name, r.kind])).toEqual([['Gold foil', 'pack foil'], ['Meme Historian', 'title']]);
    expect(nextRewards(19).map((r) => [r.name, r.kind])).toEqual([['Prismatic', 'card back'], ['Aura Farmer', 'title']]);
    // Away from a tie: one reward, the same one nextReward names.
    expect(nextRewards(3).map((r) => [r.name, r.kind])).toEqual([['Midnight', 'card back']]);
    expect(nextRewards(3)[0]).toEqual(nextReward(3));
    expect(nextRewards(30)).toEqual([]);
    // Every level with several rewards puts the title last, so nextReward never hides a choosable one behind it.
    for (let level = 0; level < 31; level++) {
      const kinds = nextRewards(level).map((r) => r.kind);
      expect(kinds.lastIndexOf('title'), `level ${level}`).toBe(kinds.includes('title') ? kinds.length - 1 : -1);
    }
  });

  it('words a level-up by what the player can actually do (#719)', () => {
    // A title has no picker: it equips itself, and the line never sends the player to pick it.
    expect(levelUpLine(2, 3)).toBe('Title equipped: Pack Rat.');
    expect(levelUpLine(4, 5)).toBe('Title equipped: Certified Opener.');
    // A card back or foil does have one (Profile, Card back and foil).
    expect(levelUpLine(3, 4)).toBe('Unlocked the Midnight card back. Pick it on your Profile.');
    expect(levelUpLine(5, 6)).toBe('Unlocked the Shimmer pack foil. Pick it on your Profile.');
    // Several levels at once: the highest title equips; only the choosable rewards are picked.
    expect(levelUpLine(2, 8)).toBe(
      'Title equipped: Holo Hunter. Unlocked the Midnight card back, the Vaporwave card back, the Shimmer pack foil. Pick them on your Profile.',
    );
    // Nothing new: a teaser for the next reward, or the end of the list.
    expect(levelUpLine(1, 2)).toBe('Next: Pack Rat at level 3.');
    // A level that holds two rewards names both, choosable first (#212).
    expect(levelUpLine(10, 11)).toBe('Next: Gold foil and Meme Historian at level 12.');
    expect(levelUpLine(18, 19)).toBe('Next: Prismatic and Aura Farmer at level 20.');
    expect(levelUpLine(29, 30)).toBe('Title equipped: Brainrot Royalty.');
    expect(levelUpLine(30, 31)).toBe('Keep opening.');
    // Only a title is ever "equipped": no line tells the player to pick a title.
    for (let level = 2; level <= 31; level++) {
      const picks = levelUpLine(level - 1, level).split('. ').filter((sentence) => /pick/i.test(sentence));
      expect(picks.some((sentence) => /title/i.test(sentence))).toBe(false);
    }
  });

  it('only uses rewards that are unlocked', () => {
    expect(usable(CARD_BACKS, 'gold', 10)).toBe('gold');
    expect(usable(CARD_BACKS, 'gold', 9)).toBe('classic');
    expect(usable(PACK_FOILS, undefined, 50)).toBe('standard');
    expect(usable(PACK_FOILS, 'nonsense', 50)).toBe('standard');
  });

  it('places a score between milestones', () => {
    expect(collectionMilestone(0)).toEqual({ current: undefined, next: COLLECTION_MILESTONES[0] });
    expect(collectionMilestone(1_000)).toEqual({ current: COLLECTION_MILESTONES[0], next: COLLECTION_MILESTONES[1] });
    expect(collectionMilestone(10 ** 9)).toEqual({ current: COLLECTION_MILESTONES[COLLECTION_MILESTONES.length - 1], next: undefined });
  });

  it('completes and masters sets', () => {
    expect(setProgress(11, 0, 12)).toBeNull();
    expect(setProgress(12, 3, 12)).toBe('complete');
    expect(setProgress(12, 12, 12)).toBe('master');
    expect(setProgress(0, 0, 0)).toBeNull();
  });
});
