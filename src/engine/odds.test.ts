import { describe, expect, it } from 'vitest';
import { ALL_SET_VERSIONS } from '../content/sets';
import { scoreAtLeastChance } from './odds';
import { scorePack } from './scoring';
import { FINISHES_RAREST_FIRST, MODIFIERS_V1, ODDS_TOTAL, validateSet, type Finish, type Rarity, type SetDefinition } from './types';

const tinySet = (modifiers?: 1) => validateSet({
  id: 'score-odds-test',
  version: 1,
  name: 'Score Odds Test',
  era: 'now',
  releasedAt: '2026-10-12',
  packSize: 3,
  odds: { COMMON: 7000, UNCOMMON: 0, RARE: 2500, EPIC: 0, LEGENDARY: 0, BRAINROT: 500 },
  holoOdds: 500,
  ...(modifiers ? { modifiers } : {}),
  cards: [
    { id: 'c1', name: 'C1', rarity: 'COMMON' },
    { id: 'c2', name: 'C2', rarity: 'COMMON' },
    { id: 'r1', name: 'R1', rarity: 'RARE' },
    { id: 'b1', name: 'B1', rarity: 'BRAINROT' },
  ],
});

interface Slot { cardId: string; rarity: Rarity; isHolo: boolean; finish: Finish | null; misprint: boolean; chance: number }

/** Every way one slot can roll, with its chance, straight from the pack rules. */
const slotOutcomes = (set: SetDefinition): Slot[] => {
  const out: Slot[] = [];
  const finishes: [Finish | null, number][] = set.modifiers === 1
    ? [...FINISHES_RAREST_FIRST.map((f) => [f, MODIFIERS_V1.finishOdds[f]] as [Finish, number]),
      [null, ODDS_TOTAL - FINISHES_RAREST_FIRST.reduce((s, f) => s + MODIFIERS_V1.finishOdds[f], 0)]]
    : [[null, ODDS_TOTAL]];
  const misprints: [boolean, number][] = set.modifiers === 1
    ? [[true, MODIFIERS_V1.misprintOdds], [false, ODDS_TOTAL - MODIFIERS_V1.misprintOdds]]
    : [[false, ODDS_TOTAL]];
  for (const card of set.cards) {
    const pick = set.odds[card.rarity] / ODDS_TOTAL / set.cards.filter((c) => c.rarity === card.rarity).length;
    for (const [isHolo, h] of [[true, set.holoOdds], [false, ODDS_TOTAL - set.holoOdds]] as const) {
      for (const [finish, f] of finishes) {
        for (const [misprint, m] of misprints) {
          out.push({ cardId: card.id, rarity: card.rarity, isHolo, finish, misprint, chance: pick * (h / ODDS_TOTAL) * (f / ODDS_TOTAL) * (m / ODDS_TOTAL) });
        }
      }
    }
  }
  return out.filter((o) => o.chance > 0);
};

/** The chance of each score, by trying every pack. */
const bruteForce = (set: SetDefinition) => {
  const slots = slotOutcomes(set);
  const byScore = new Map<number, number>();
  const walk = (pack: Slot[], chance: number) => {
    if (pack.length === set.packSize) {
      const { score } = scorePack(pack);
      byScore.set(score, (byScore.get(score) ?? 0) + chance);
      return;
    }
    for (const s of slots) walk([...pack, s], chance * s.chance);
  };
  walk([], 1);
  const scores = [...byScore.keys()].sort((a, b) => b - a);
  let atLeast = 0;
  return scores.map((score) => ({ score, atLeast: (atLeast += byScore.get(score)!) }));
};

describe('scoreAtLeastChance', () => {
  for (const modifiers of [undefined, 1 as const]) {
    it(`matches trying every pack ${modifiers ? 'with' : 'without'} modifiers`, () => {
      const set = tinySet(modifiers);
      const exact = bruteForce(set);
      // Every score a pack can make, and just above it.
      for (const { score, atLeast } of exact) {
        expect(scoreAtLeastChance(set, score)).toBeCloseTo(atLeast, 12);
      }
      for (let i = 1; i < exact.length; i++) {
        expect(scoreAtLeastChance(set, exact[i].score + 1)).toBeCloseTo(exact[i - 1].atLeast, 12);
      }
      expect(scoreAtLeastChance(set, exact[0].score + 1)).toBe(0);
    });
  }

  it('is 1 for the lowest score and below, and never rises as the score does', () => {
    const set = tinySet(1);
    expect(scoreAtLeastChance(set, 0)).toBe(1);
    expect(scoreAtLeastChance(set, -5)).toBe(1);
    expect(scoreAtLeastChance(set, 30)).toBeCloseTo(1, 12);
    let last = 1;
    for (let score = 1; score < 1e12; score *= 3) {
      const chance = scoreAtLeastChance(set, score)!;
      expect(chance).toBeLessThanOrEqual(last);
      last = chance;
    }
  });

  it('is null for a modifier table it does not know', () => {
    expect(scoreAtLeastChance({ ...tinySet(1), modifiers: 2 as unknown as 1 }, 100)).toBeNull();
  });

  it('works out every released set', () => {
    for (const set of ALL_SET_VERSIONS) {
      const common = scoreAtLeastChance(set, 300)!;
      expect(common).toBeGreaterThan(0.2);
      expect(common).toBeLessThan(1);
      expect(scoreAtLeastChance(set, 1e8)!).toBeLessThan(1e-4);
    }
  });
});
