import { handFromCounts, POKER_HANDS, type HandKey } from './scoring';
import { MODIFIERS_V1, ODDS_TOTAL, type Finish, type SetDefinition } from './types';

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
