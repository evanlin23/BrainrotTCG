import { describe, expect, it } from 'vitest';
import {
  computeDroughtCounters,
  formatDroughtAccessible,
  formatDroughtStreak,
  type DroughtStreak,
} from './droughtCounters';
import type { HistoryEntry } from './history';
import { SETS } from '../content/sets';

describe('droughtCounters', () => {
  // Use real sets so getSet finds card rarities
  const testSet = SETS[0]; // Genesis
  const brainrotCard = testSet.cards.find((c) => c.rarity === 'BRAINROT')!;
  const legendaryCard = testSet.cards.find((c) => c.rarity === 'LEGENDARY')!;
  const epicCard = testSet.cards.find((c) => c.rarity === 'EPIC')!;
  const commonCard = testSet.cards.find((c) => c.rarity === 'COMMON')!;

  const makeEntry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
    setId: testSet.id,
    setVersion: testSet.version,
    nonce: 0,
    key: '0123456789abcdef',
    cards: [{ id: commonCard.id, holo: false }],
    hand: 'No Match',
    score: 50,
    openedAt: 1000,
    ...overrides,
  });

  describe('computeDroughtCounters', () => {
    it('handles empty history', () => {
      const stats = computeDroughtCounters([]);
      expect(stats.totalPacks).toBe(0);
      expect(stats.brainrot).toEqual({ packsSince: 0, foundInHistory: false });
      expect(stats.legendaryPlus).toEqual({ packsSince: 0, foundInHistory: false });
      expect(stats.epicPlus).toEqual({ packsSince: 0, foundInHistory: false });
      expect(stats.rankingsQualifier).toEqual({ packsSince: 0, foundInHistory: false });
    });

    it('reports 0 packs since when top rarity is in the most recent pack', () => {
      const entry = makeEntry({
        cards: [{ id: brainrotCard.id, holo: false }],
        hand: 'No Match',
        score: 1000,
      });

      const stats = computeDroughtCounters([entry]);
      expect(stats.totalPacks).toBe(1);
      expect(stats.brainrot).toEqual({ packsSince: 0, foundInHistory: true });
      expect(stats.legendaryPlus).toEqual({ packsSince: 0, foundInHistory: true });
      expect(stats.epicPlus).toEqual({ packsSince: 0, foundInHistory: true });
    });

    it('tracks independent drought distances for each tier', () => {
      // Index 0 (newest): Common only, non-qualifying
      // Index 1: Epic card, non-qualifying
      // Index 2: Legendary card, non-qualifying
      // Index 3: Brainrot card, qualifies for Rankings
      const history: HistoryEntry[] = [
        makeEntry({
          nonce: 3,
          cards: [{ id: commonCard.id, holo: false }],
          hand: 'No Match',
          score: 50,
        }),
        makeEntry({
          nonce: 2,
          cards: [{ id: epicCard.id, holo: false }],
          hand: 'No Match',
          score: 120,
        }),
        makeEntry({
          nonce: 1,
          cards: [{ id: legendaryCard.id, holo: false }],
          hand: 'No Match',
          score: 250,
        }),
        makeEntry({
          nonce: 0,
          cards: [{ id: brainrotCard.id, holo: false }],
          hand: 'Five of a Kind',
          score: 5000000,
        }),
      ];

      const stats = computeDroughtCounters(history);
      expect(stats.totalPacks).toBe(4);

      // Epic+ was pulled 1 pack ago (at index 1)
      expect(stats.epicPlus).toEqual({ packsSince: 1, foundInHistory: true });
      // Legendary+ was pulled 2 packs ago (at index 2)
      expect(stats.legendaryPlus).toEqual({ packsSince: 2, foundInHistory: true });
      // Brainrot was pulled 3 packs ago (at index 3)
      expect(stats.brainrot).toEqual({ packsSince: 3, foundInHistory: true });
      // Rankings qualifier was at index 3
      expect(stats.rankingsQualifier).toEqual({ packsSince: 3, foundInHistory: true });
    });

    it('counts total streak when rarity has never been pulled', () => {
      const history: HistoryEntry[] = [
        makeEntry({ nonce: 2, cards: [{ id: commonCard.id, holo: false }] }),
        makeEntry({ nonce: 1, cards: [{ id: commonCard.id, holo: false }] }),
        makeEntry({ nonce: 0, cards: [{ id: commonCard.id, holo: false }] }),
      ];

      const stats = computeDroughtCounters(history);
      expect(stats.totalPacks).toBe(3);
      expect(stats.brainrot).toEqual({ packsSince: 3, foundInHistory: false });
      expect(stats.legendaryPlus).toEqual({ packsSince: 3, foundInHistory: false });
      expect(stats.epicPlus).toEqual({ packsSince: 3, foundInHistory: false });
      expect(stats.rankingsQualifier).toEqual({ packsSince: 3, foundInHistory: false });
    });

    it('scopes by playerKeyHex', () => {
      const myKey = '0123456789abcdef0000111122223333';
      const otherKey = 'fedcba98765432100000111122223333';

      const history: HistoryEntry[] = [
        makeEntry({
          key: otherKey.slice(0, 16),
          cards: [{ id: brainrotCard.id, holo: false }],
        }),
        makeEntry({
          key: myKey.slice(0, 16),
          cards: [{ id: commonCard.id, holo: false }],
        }),
      ];

      const stats = computeDroughtCounters(history, { playerKeyHex: myKey });
      expect(stats.totalPacks).toBe(1);
      expect(stats.brainrot).toEqual({ packsSince: 1, foundInHistory: false });
    });

    it('scopes by setId', () => {
      const otherSet = SETS[1];
      const otherSetCommon = otherSet.cards.find((c) => c.rarity === 'COMMON')!;

      const history: HistoryEntry[] = [
        makeEntry({
          nonce: 1,
          setId: otherSet.id,
          setVersion: otherSet.version,
          cards: [{ id: otherSetCommon.id, holo: false }],
        }),
        makeEntry({
          nonce: 0,
          setId: testSet.id,
          setVersion: testSet.version,
          cards: [{ id: brainrotCard.id, holo: false }],
        }),
      ];

      const scopedToOther = computeDroughtCounters(history, { setId: otherSet.id });
      expect(scopedToOther.totalPacks).toBe(1);
      expect(scopedToOther.brainrot).toEqual({ packsSince: 1, foundInHistory: false });

      const scopedToTest = computeDroughtCounters(history, { setId: testSet.id });
      expect(scopedToTest.totalPacks).toBe(1);
      expect(scopedToTest.brainrot).toEqual({ packsSince: 0, foundInHistory: true });
    });

    it('honestly bounds streaks when older pack cards are missing due to quota eviction', () => {
      const history: HistoryEntry[] = [
        makeEntry({ nonce: 2, cards: [{ id: commonCard.id, holo: false }] }),
        makeEntry({ nonce: 1, cards: [{ id: commonCard.id, holo: false }] }),
        makeEntry({ nonce: 0, cards: null, hand: 'No Match', score: 20 }), // Evicted cards
      ];

      const stats = computeDroughtCounters(history);
      expect(stats.totalPacks).toBe(3);
      // Bounded at 2 packs because pack at index 2 has missing cards
      expect(stats.brainrot).toEqual({
        packsSince: 2,
        foundInHistory: false,
        isBoundedByIncompleteHistory: true,
      });
      // Rankings qualifier is NOT bounded because hand and score are preserved
      expect(stats.rankingsQualifier).toEqual({
        packsSince: 3,
        foundInHistory: false,
      });
    });
  });

  describe('scope and limits (#757)', () => {
    const myKey = '0123456789abcdef0000111122223333';

    it("counts only records whose key is exactly this player's, not a shorter or empty one", () => {
      const history: HistoryEntry[] = [
        makeEntry({ nonce: 3, key: '', cards: [{ id: brainrotCard.id, holo: false }] }),
        makeEntry({ nonce: 2, key: '01234567', cards: [{ id: brainrotCard.id, holo: false }] }),
        makeEntry({ nonce: 1, key: myKey.slice(0, 16) }),
        makeEntry({ nonce: 0, key: myKey.slice(0, 16) }),
      ];

      const stats = computeDroughtCounters(history, { playerKeyHex: myKey });
      expect(stats.totalPacks).toBe(2);
      expect(stats.brainrot).toEqual({ packsSince: 2, foundInHistory: false });
    });

    it('counts a ticket recorded twice once, as the record the profile admits (opened first)', () => {
      const history: HistoryEntry[] = [
        // A later conflicting record of ticket 1 (another tab, or a backup) with a Brainrot in it.
        makeEntry({ nonce: 1, openedAt: 3000, cards: [{ id: brainrotCard.id, holo: false }] }),
        makeEntry({ nonce: 2, openedAt: 2500 }),
        makeEntry({ nonce: 1, openedAt: 2000 }),
        makeEntry({ nonce: 0, openedAt: 1000, cards: [{ id: brainrotCard.id, holo: false }] }),
      ];

      const stats = computeDroughtCounters(history);
      expect(stats.totalPacks).toBe(3);
      expect(stats.brainrot).toEqual({ packsSince: 2, foundInHistory: true });
    });

    it('bounds the count at a pack from a set version this build does not know, instead of counting it as a miss', () => {
      const history: HistoryEntry[] = [
        makeEntry({ nonce: 3 }),
        makeEntry({ nonce: 2, setVersion: 999, cards: [{ id: brainrotCard.id, holo: false }] }),
        makeEntry({ nonce: 1 }),
        makeEntry({ nonce: 0, cards: [{ id: brainrotCard.id, holo: false }] }),
      ];

      const stats = computeDroughtCounters(history);
      expect(stats.brainrot).toEqual({ packsSince: 1, foundInHistory: false, isBoundedByIncompleteHistory: true });
      expect(formatDroughtStreak(stats.brainrot)).toBe('1+');
    });

    it('counts the same whatever order the caller passes the history in (#1287)', () => {
      // historyForKey's ticket order (oldest first): the Brainrot is the oldest pack, three packs ago.
      const ascending: HistoryEntry[] = [
        makeEntry({ nonce: 0, openedAt: 1000, cards: [{ id: brainrotCard.id, holo: false }] }),
        makeEntry({ nonce: 1, openedAt: 2000 }),
        makeEntry({ nonce: 2, openedAt: 3000 }),
        makeEntry({ nonce: 3, openedAt: 4000, cards: [{ id: epicCard.id, holo: false }] }),
      ];
      const fromAscending = computeDroughtCounters(ascending);
      expect(fromAscending.brainrot).toEqual({ packsSince: 3, foundInHistory: true });
      expect(fromAscending.epicPlus).toEqual({ packsSince: 0, foundInHistory: true });
      expect(computeDroughtCounters([...ascending].reverse())).toEqual(fromAscending);
      // The caller's array is left as it was.
      expect(ascending.map((e) => e.nonce)).toEqual([0, 1, 2, 3]);
    });

    it('bounds the count at a card id the set does not list, instead of counting the pack as a miss (#1287)', () => {
      const history: HistoryEntry[] = [
        makeEntry({ nonce: 3 }),
        makeEntry({ nonce: 2, cards: [{ id: commonCard.id, holo: false }, { id: 'not-a-card', holo: false }] }),
        makeEntry({ nonce: 1 }),
        makeEntry({ nonce: 0, cards: [{ id: brainrotCard.id, holo: false }] }),
      ];

      const stats = computeDroughtCounters(history);
      expect(stats.brainrot).toEqual({ packsSince: 1, foundInHistory: false, isBoundedByIncompleteHistory: true });
      expect(stats.epicPlus).toEqual({ packsSince: 1, foundInHistory: false, isBoundedByIncompleteHistory: true });
      expect(stats.totalPacks).toBe(4);
    });

    it('still counts a hit in a pack that also holds an unknown card id (#1287)', () => {
      const history: HistoryEntry[] = [
        makeEntry({ nonce: 1 }),
        makeEntry({ nonce: 0, cards: [{ id: 'not-a-card', holo: false }, { id: epicCard.id, holo: false }] }),
      ];

      const stats = computeDroughtCounters(history);
      expect(stats.epicPlus).toEqual({ packsSince: 1, foundInHistory: true });
      expect(stats.brainrot).toEqual({ packsSince: 1, foundInHistory: false, isBoundedByIncompleteHistory: true });
    });
  });

  describe('formatDroughtStreak', () => {
    it('formats exact counts', () => {
      expect(formatDroughtStreak({ packsSince: 0, foundInHistory: true })).toBe('0');
      expect(formatDroughtStreak({ packsSince: 42, foundInHistory: true })).toBe('42');
    });

    it('marks unpulled counts with an asterisk', () => {
      expect(formatDroughtStreak({ packsSince: 50, foundInHistory: false })).toBe('50*');
    });

    it('marks incomplete/bounded counts with a plus', () => {
      expect(
        formatDroughtStreak({
          packsSince: 15,
          foundInHistory: false,
          isBoundedByIncompleteHistory: true,
        }),
      ).toBe('15+');
    });
  });

  describe('formatDroughtAccessible', () => {
    it('describes zero pack hit', () => {
      const s: DroughtStreak = { packsSince: 0, foundInHistory: true };
      expect(formatDroughtAccessible(s, 'Brainrot')).toBe(
        'Brainrot: 0 packs (pulled in your most recent pack)',
      );
    });

    it('describes hit with count', () => {
      const s: DroughtStreak = { packsSince: 7, foundInHistory: true };
      expect(formatDroughtAccessible(s, 'Epic+')).toBe('Epic+: 7 packs since last pull');
    });

    it('describes unpulled hit', () => {
      const s: DroughtStreak = { packsSince: 50, foundInHistory: false };
      expect(formatDroughtAccessible(s, 'Brainrot')).toBe('Brainrot: none in 50 recorded packs');
    });

    it('describes bounded hit', () => {
      const s: DroughtStreak = {
        packsSince: 20,
        foundInHistory: false,
        isBoundedByIncompleteHistory: true,
      };
      expect(formatDroughtAccessible(s, 'Brainrot')).toBe(
        "Brainrot: at least 20 packs since last pull (older packs' cards unavailable)",
      );
    });
  });
});
