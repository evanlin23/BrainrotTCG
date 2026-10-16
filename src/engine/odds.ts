import { FINISH_MULTIPLIER, handFromCounts, HOLO_MULTIPLIER, MISPRINT_MULTIPLIER, POKER_HANDS, RARITY_POINTS, type HandKey } from './scoring';
import { MODIFIERS_V1, ODDS_TOTAL, type Finish, type Rarity, type SetDefinition } from './types';

/**
 * Exact chance of each combo for one pack of a set, by enumerating every
 * multiset of cards (a 5-card pack from 19 cards is only ~34k cases).
 */
export const handOdds = (set: SetDefinition): Record<HandKey, number> => {
  const counts = new Map<string, number>();
  for (const c of set.cards) counts.set(c.rarity, (counts.get(c.rarity) ?? 0) + 1);
  const p = set.cards.map((c) => set.odds[c.rarity] / ODDS_TOTAL / counts.get(c.rarity)!);
  const n = p.length;
  const k = set.packSize;
  const factorial = (x: number): number => (x <= 1 ? 1 : x * factorial(x - 1));
  const result = Object.fromEntries(Object.keys(POKER_HANDS).map((h) => [h, 0])) as Record<HandKey, number>;

  // Recursively choose how many copies of card i (non-increasing index order = multisets).
  const copies: number[] = [];
  const walk = (i: number, remaining: number, prob: number, multinomial: number) => {
    if (remaining === 0) {
      result[handFromCounts(copies.filter((c) => c > 0))] += prob * multinomial;
      return;
    }
    if (i === n) return;
    for (let m = remaining; m >= 0; m--) {
      copies.push(m);
      walk(i + 1, remaining - m, prob * p[i] ** m, multinomial / factorial(m));
      copies.pop();
    }
  };
  walk(0, k, 1, factorial(k));
  return result;
};

/** The modifier tables this build knows, by the number a set names in `"modifiers"` (spec section 5.4). */
const MODIFIER_TABLES: Readonly<Partial<Record<number, { finishOdds: Readonly<Record<Finish, number>>; misprintOdds: number }>>> = {
  1: MODIFIERS_V1,
};

/**
 * Exact chance that a pack has at least one special card: holo, a finish or a misprint. generatePack
 * rolls each card's holo, finish and misprint separately, so a card is plain when all three miss and
 * a pack is plain only when every card is. Null for a modifier table this build doesn't know, rather
 * than a chance that leaves its modifiers out.
 */
export const specialPackChance = (set: Pick<SetDefinition, 'holoOdds' | 'packSize' | 'modifiers'>): number | null => {
  let plainCard = 1 - set.holoOdds / ODDS_TOTAL;
  if (set.modifiers !== undefined) {
    const table = MODIFIER_TABLES[set.modifiers];
    if (!table) return null;
    const finished = Object.values(table.finishOdds).reduce((a, b) => a + b, 0);
    plainCard *= (1 - finished / ODDS_TOTAL) * (1 - table.misprintOdds / ODDS_TOTAL);
  }
  return 1 - plainCard ** set.packSize;
};

/**
 * One card's modifier multiplier (holo x finish x misprint) and its chance, as generatePack rolls them:
 * each separately, at most one finish. Equal multipliers are merged. Null for a modifier table this
 * build doesn't know.
 */
const modifierMultipliers = (set: Pick<SetDefinition, 'holoOdds' | 'modifiers'>): Modifiers | null => {
  const holo = set.holoOdds / ODDS_TOTAL;
  let rolls = [{ multiplier: 1, chance: 1 - holo }, { multiplier: HOLO_MULTIPLIER, chance: holo }];
  if (set.modifiers !== undefined) {
    const table = MODIFIER_TABLES[set.modifiers];
    if (!table) return null;
    const finishes = Object.entries(table.finishOdds) as [Finish, number][];
    const finished = finishes.reduce((a, [, odds]) => a + odds, 0);
    const finish = [{ multiplier: 1, chance: 1 - finished / ODDS_TOTAL }, ...finishes.map(([f, odds]) => ({ multiplier: FINISH_MULTIPLIER[f], chance: odds / ODDS_TOTAL }))];
    const misprint = table.misprintOdds / ODDS_TOTAL;
    for (const next of [finish, [{ multiplier: 1, chance: 1 - misprint }, { multiplier: MISPRINT_MULTIPLIER, chance: misprint }]]) {
      rolls = rolls.flatMap((a) => next.map((b) => ({ multiplier: a.multiplier * b.multiplier, chance: a.chance * b.chance })));
    }
  }
  const merged = new Map<number, number>();
  for (const { multiplier, chance } of rolls) if (chance > 0) merged.set(multiplier, (merged.get(multiplier) ?? 0) + chance);
  return [...merged].map(([multiplier, chance]) => ({ multiplier, chance })).sort((a, b) => b.multiplier - a.multiplier);
};

type Modifiers = { multiplier: number; chance: number }[];
type Group = { multiplier: number; points: number[]; chance: number };

/** Each set's packs grouped by combo multiplier and rarity points (largest first), with each group's chance. */
const packGroups = new WeakMap<SetDefinition, Group[]>();

const groupsOf = (set: SetDefinition): Group[] => {
  const cached = packGroups.get(set);
  if (cached) return cached;
  const rarityCounts = new Map<Rarity, number>();
  for (const c of set.cards) rarityCounts.set(c.rarity, (rarityCounts.get(c.rarity) ?? 0) + 1);
  const p = set.cards.map((c) => set.odds[c.rarity] / ODDS_TOTAL / rarityCounts.get(c.rarity)!);
  const n = p.length;
  const factorial = (x: number): number => (x <= 1 ? 1 : x * factorial(x - 1));
  const groups = new Map<string, Group>();
  // The same multiset walk as handOdds.
  const copies: number[] = [];
  const walk = (i: number, remaining: number, prob: number, multinomial: number) => {
    if (remaining === 0) {
      const multiplier = POKER_HANDS[handFromCounts(copies.filter((c) => c > 0))].multiplier;
      const points = copies.flatMap((m, j) => Array<number>(m).fill(RARITY_POINTS[set.cards[j].rarity])).sort((a, b) => b - a);
      const key = `${multiplier}:${points.join(',')}`;
      const group = groups.get(key);
      if (group) group.chance += prob * multinomial;
      else groups.set(key, { multiplier, points, chance: prob * multinomial });
      return;
    }
    if (i === n) return;
    for (let m = remaining; m >= 0; m--) {
      copies.push(m);
      walk(i + 1, remaining - m, prob * p[i] ** m, multinomial / factorial(m));
      copies.pop();
    }
  };
  walk(0, set.packSize, 1, factorial(set.packSize));
  const result = [...groups.values()];
  packGroups.set(set, result);
  return result;
};

/** Every sum that cards with these rarity points can make with their modifier rolls, ascending, with the chance of that sum or more. */
const sumTails = new Map<string, { sums: number[]; atLeast: number[] }>();

const sumTail = (points: number[], modifiers: Modifiers, modifiersKey: string) => {
  const key = `${modifiersKey}|${points.join(',')}`;
  const cached = sumTails.get(key);
  if (cached) return cached;
  let dist = new Map<number, number>([[0, 1]]);
  for (const pt of points) {
    const next = new Map<number, number>();
    for (const [sum, chance] of dist) {
      for (const m of modifiers) {
        const value = sum + pt * m.multiplier;
        next.set(value, (next.get(value) ?? 0) + chance * m.chance);
      }
    }
    dist = next;
  }
  const sums = [...dist.keys()].sort((a, b) => a - b);
  const atLeast = new Array<number>(sums.length + 1).fill(0);
  for (let i = sums.length - 1; i >= 0; i--) atLeast[i] = atLeast[i + 1] + dist.get(sums[i])!;
  const tail = { sums, atLeast };
  sumTails.set(key, tail);
  return tail;
};

/**
 * Exact chance that one pack of a set scores at least `score` (sum of card points x combo multiplier),
 * over every pack: the cards, so the combo and rarities, and each card's modifiers. Packs are grouped
 * by combo and rarities as handOdds walks them; in each group the pack is split in two halves, every
 * sum each half can make is listed once, and each sum of one half is matched with the sums of the other
 * that reach the score. Null for a modifier table this build doesn't know. Display only: packs and
 * scores don't depend on it. The groups and half-sums are cached, so later calls are quick.
 */
export const scoreAtLeastChance = (set: SetDefinition, score: number): number | null => {
  const modifiers = modifierMultipliers(set);
  if (!modifiers) return null;
  if (score <= 0) return 1;
  const modifiersKey = modifiers.map((m) => `${m.multiplier}@${m.chance}`).join(',');
  let total = 0;
  for (const { multiplier, points, chance } of groupsOf(set)) {
    // The smallest card-points sum whose score reaches `score`, in integers so it is exact.
    let need = Math.ceil(score / multiplier);
    while ((need - 1) * multiplier >= score) need--;
    while (need * multiplier < score) need++;
    const half = Math.floor(points.length / 2);
    const left = sumTail(points.slice(0, half), modifiers, modifiersKey);
    const right = sumTail(points.slice(half), modifiers, modifiersKey);
    let reach = 0;
    for (let i = 0; i < left.sums.length; i++) {
      // The first right-half sum that, with this left-half sum, reaches need.
      const want = need - left.sums[i];
      let lo = 0;
      let hi = right.sums.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (right.sums[mid] < want) lo = mid + 1;
        else hi = mid;
      }
      reach += (left.atLeast[i] - left.atLeast[i + 1]) * right.atLeast[lo];
    }
    total += chance * reach;
  }
  return Math.min(total, 1);
};

/** "1 in N" for display. */
export const oneIn = (chance: number): number => (chance > 0 ? 1 / chance : Infinity);

/** One exact version of a card: the card plus its holo, finish and misprint. */
export interface CardVersionKey {
  cardId: string;
  isHolo: boolean;
  finish?: Finish | null;
  misprint?: boolean;
}

/**
 * Exact chance that one pack of a set has at least one copy of this exact version (same card, holo,
 * finish and misprint), from generatePack's rules: every slot rolls rarity, card, holo and (with
 * modifiers) finish and misprint independently, so a slot hits with the product of those chances and
 * a pack misses only when every slot does. 0 for a card or modifier the set can't produce; null for a
 * modifier table this build doesn't know.
 */
export const versionPackChance = (
  set: Pick<SetDefinition, 'cards' | 'odds' | 'holoOdds' | 'packSize' | 'modifiers'>,
  version: CardVersionKey,
): number | null => {
  const card = set.cards.find((c) => c.id === version.cardId);
  if (!card) return 0;
  const pool = set.cards.filter((c) => c.rarity === card.rarity).length;
  const holo = set.holoOdds / ODDS_TOTAL;
  let slot = set.odds[card.rarity] / ODDS_TOTAL / pool * (version.isHolo ? holo : 1 - holo);
  const finish = version.finish ?? null;
  if (set.modifiers === undefined) {
    if (finish || version.misprint) return 0;
  } else {
    const table = MODIFIER_TABLES[set.modifiers];
    if (!table) return null;
    const finished = Object.values(table.finishOdds).reduce((a, b) => a + b, 0);
    const misprint = table.misprintOdds / ODDS_TOTAL;
    slot *= (finish ? table.finishOdds[finish] : ODDS_TOTAL - finished) / ODDS_TOTAL;
    slot *= version.misprint ? misprint : 1 - misprint;
  }
  return 1 - (1 - slot) ** set.packSize;
};
