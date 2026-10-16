import { handOdds, oneIn } from './odds';
import { cardPoints, POKER_HANDS, scorePack, type HandKey, type PokerHand } from './scoring';
import type { Finish, Rarity, SetDefinition } from './types';

interface HeadlineCard {
  /** Cards match when this is equal, as in scorePack. */
  cardId: string;
  rarity: Rarity;
  isHolo: boolean;
  finish?: Finish | null;
  misprint?: boolean;
  /** Position in the pack (engine order). Without it, the card's index stands in for it. */
  slot?: number;
}

export interface PackHeadline<T extends HeadlineCard> {
  /** Pack total: the pack's Brainrot Score, sum of card points x combo multiplier. */
  total: number;
  /** Sum of the cards' points, before the combo multiplier. */
  points: number;
  /** The combo and its multiplier (No Matches x1 included: it explains the formula). */
  combo: PokerHand;
  /** Standout card: the highest card points, with those points (never the pack multiplier). Null for an empty pack. */
  standout: { card: T; points: number } | null;
}

/**
 * The pull headline (docs/DESIGN.md, #339): Pack total, then the combo, then the Standout card. It
 * reuses scorePack, so there is no second scorer. Pass the cards as reconstructed in their own set
 * version; their modifiers set their points. The standout is the card with the most card points; on a
 * tie the higher slot wins (the shipped best-card rule). Without slots, the later card in the list
 * wins, so pass engine order or an order that keeps it among ties (revealOrder does).
 */
export const packHeadline = <T extends HeadlineCard>(cards: readonly T[]): PackHeadline<T> => {
  const { points, hand, score } = scorePack(cards);
  let standout: { card: T; points: number; slot: number } | null = null;
  cards.forEach((card, i) => {
    const value = cardPoints(card.rarity, card.isHolo, card.finish, card.misprint);
    const slot = card.slot ?? i;
    if (!standout || value > standout.points || (value === standout.points && slot > standout.slot)) standout = { card, points: value, slot };
  });
  const best = standout as { card: T; points: number } | null;
  return { total: score, points, combo: hand, standout: best && { card: best.card, points: best.points } };
};

/**
 * How rare a combo is in this set, as "1 in N packs" (exact odds from handOdds). Null for No Matches,
 * which is not an event, and for a hand that isn't one of POKER_HANDS. handOdds enumerates every pack,
 * so callers memoize this.
 */
export const comboOneIn = (set: SetDefinition, combo: PokerHand): number | null => {
  const key = (Object.keys(POKER_HANDS) as HandKey[]).find((k) => POKER_HANDS[k] === combo);
  if (!key || key === 'NO_MATCH') return null;
  const n = oneIn(handOdds(set)[key]);
  return Number.isFinite(n) ? n : null;
};
