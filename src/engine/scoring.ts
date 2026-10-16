import type { Finish, Rarity } from './types';

/**
 * Brainrot Score: every number here follows from the odds, so rarer always
 * means bigger.
 *
 * - Card points are about 20 / (chance of that rarity): Common 50% -> 10,
 *   Uncommon 25% -> 20, Rare 15% -> 35, Epic 7% -> 70, Legendary 2.5% -> 200,
 *   Brainrot 0.5% -> 1,000.
 * - Holo (5% of cards) multiplies a card's points by 20 = 1 / 5%.
 * - In sets with modifiers, a finish and a misprint multiply them again, each by about
 *   1 / (its chance): Silver 10% x10, Gold 2.5% x40, Platinum 0.5% x200, Diamond 0.1% x1000,
 *   Misprint 0.5% x200. They all stack.
 * - Combo multipliers are about 1 / (chance of that hand) in a typical set
 *   (see odds.ts for the exact odds of any set).
 *
 * Pack Brainrot Score = sum of card points x combo multiplier.
 */
export const RARITY_POINTS: Record<Rarity, number> = {
  COMMON: 10,
  UNCOMMON: 20,
  RARE: 35,
  EPIC: 70,
  LEGENDARY: 200,
  BRAINROT: 1000,
};

export const HOLO_MULTIPLIER = 20;

export const FINISH_MULTIPLIER: Record<Finish, number> = { SILVER: 10, GOLD: 40, PLATINUM: 200, DIAMOND: 1000 };

export const MISPRINT_MULTIPLIER = 200;

export interface PokerHand {
  name: string;
  multiplier: number;
}

/** Combos (matching = same card), best first. */
export const POKER_HANDS = {
  FIVE_OF_A_KIND: { name: '5 of a Kind', multiplier: 10_000 },
  FOUR_OF_A_KIND: { name: '4 of a Kind', multiplier: 250 },
  FULL_HOUSE: { name: 'Full House', multiplier: 150 },
  THREE_OF_A_KIND: { name: '3 of a Kind', multiplier: 15 },
  TWO_PAIR: { name: 'Two Pair', multiplier: 10 },
  PAIR: { name: 'Pair', multiplier: 2 },
  NO_MATCH: { name: 'No Matches', multiplier: 1 },
} as const satisfies Record<string, PokerHand>;

export type HandKey = keyof typeof POKER_HANDS;

/**
 * Which scoring rules a score came from. Bump it whenever a change to the tables above, cardPoints or
 * scorePack would give any existing pull different points, so ranking boards never compare scores
 * made under different rules (see rankings.ts).
 */
export const SCORING_ERA = 1;

export const cardPoints = (rarity: Rarity, isHolo: boolean, finish?: Finish | null, misprint?: boolean): number =>
  (RARITY_POINTS[rarity] ?? 0) * (isHolo ? HOLO_MULTIPLIER : 1) * (finish ? FINISH_MULTIPLIER[finish] : 1) * (misprint ? MISPRINT_MULTIPLIER : 1);

interface ScorableCard {
  /** Cards match when this is equal (use `${setId}/${cardId}` or plain card id). Modifiers don't change it. */
  cardId: string;
  rarity: Rarity;
  isHolo: boolean;
  finish?: Finish | null;
  misprint?: boolean;
}

/** Classify a pack by how many copies of each card it has (sorted, biggest first). */
export const handFromCounts = (counts: number[]): HandKey => {
  const freq = [...counts].sort((a, b) => b - a);
  if (freq[0] >= 5) return 'FIVE_OF_A_KIND';
  if (freq[0] === 4) return 'FOUR_OF_A_KIND';
  if (freq[0] === 3 && freq[1] === 2) return 'FULL_HOUSE';
  if (freq[0] === 3) return 'THREE_OF_A_KIND';
  if (freq[0] === 2 && freq[1] === 2) return 'TWO_PAIR';
  if (freq[0] === 2) return 'PAIR';
  return 'NO_MATCH';
};

/** Determine the combo for a pack of cards. */
export const getPokerHand = (cards: readonly { cardId: string }[]): PokerHand => {
  if (cards.length === 0) return POKER_HANDS.NO_MATCH;
  const counts = new Map<string, number>();
  for (const card of cards) counts.set(card.cardId, (counts.get(card.cardId) ?? 0) + 1);
  return POKER_HANDS[handFromCounts([...counts.values()])];
};

export interface PackScore {
  /** Sum of the cards' points (holo included). */
  points: number;
  hand: PokerHand;
  /** Brainrot Score = points x combo multiplier. */
  score: number;
}

export const scorePack = (cards: readonly ScorableCard[]): PackScore => {
  const points = cards.reduce((sum, c) => sum + cardPoints(c.rarity, c.isHolo, c.finish, c.misprint), 0);
  const hand = getPokerHand(cards);
  return { points, hand, score: points * hand.multiplier };
};
