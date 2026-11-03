/**
 * How a pack is shown, not what it is: the pack's cards, proof and history keep the engine's
 * order. Like the rare slot in a real booster, the best card comes last.
 */
import { cardPoints, type Finish, type Rarity } from '../engine';
import { setProgress } from './progression';

export interface TakeoverSetContext {
  /** Unique cards owned in this set before this reveal. */
  ownedBefore: number;
  /** Total cards in this set. */
  size: number;
}

export interface TakeoverCollectionContext {
  /** Unique collectible cards owned before this reveal. */
  ownedBefore: number;
  /** Total collectible cards in the collection. */
  size: number;
}

export interface TakeoverContext {
  set?: TakeoverSetContext;
  collection?: TakeoverCollectionContext;
}

export type TakeoverCard = {
  rarity: Rarity;
  isNew?: boolean;
};

export type TakeoverReason = 'COLLECTION' | 'SET' | 'BRAINROT';

type Revealable = { rarity: Rarity; isHolo: boolean; finish?: Finish | null; misprint?: boolean };

/** What the card is worth: rarity times holo, finish and misprint, so a Platinum Common outranks a plain Rare. */
const rank = (card: Revealable) => cardPoints(card.rarity, card.isHolo, card.finish, card.misprint);

/** Individual card value, before any pack combo multiplier. The cutoff itself qualifies, as does any card of Brainrot rarity. */
export const SPECIAL_REVEAL_CUTOFF = 5_000;
export const SPECIAL_REVEAL_DURATION_MS = 3_000;
export const isSpecialReveal = (card: Revealable): boolean => card.rarity === 'BRAINROT' || rank(card) >= SPECIAL_REVEAL_CUTOFF;

/**
 * Which cinematic takeover trigger fired (COLLECTION > SET > BRAINROT), or null if none (Spec 1, #1293).
 *
 * Points alone never trigger a takeover. Only a new card can complete a set or collection, evaluated
 * using setProgress from progression.ts where ownedBefore + 1 reaches size.
 */
export const takeoverReason = (card: TakeoverCard, context?: TakeoverContext): TakeoverReason | null => {
  if (card.isNew && context?.collection) {
    const { ownedBefore, size } = context.collection;
    if (size > 0 && ownedBefore === size - 1 && setProgress(ownedBefore + 1, 0, size) !== null) {
      return 'COLLECTION';
    }
  }
  if (card.isNew && context?.set) {
    const { ownedBefore, size } = context.set;
    if (size > 0 && ownedBefore === size - 1 && setProgress(ownedBefore + 1, 0, size) !== null) {
      return 'SET';
    }
  }
  if (card.rarity === 'BRAINROT') {
    return 'BRAINROT';
  }
  return null;
};

/**
 * Cinematic takeover reveal trigger (Spec 1, #1293).
 *
 * Returns true when the card is of Brainrot rarity, or is a new card that completes its set,
 * or completes the collection. Points alone never trigger it (even if 10,000+ points).
 */
export const isTakeoverReveal = (card: TakeoverCard, context?: TakeoverContext): boolean =>
  takeoverReason(card, context) !== null;

/** Skip can pass ordinary cards, but every still-hidden valuable card must get its own reveal. */
export const nextSpecialRevealIndex = (cards: readonly (Revealable & { isRevealed: boolean })[]): number =>
  cards.findIndex((card) => !card.isRevealed && isSpecialReveal(card));

/** Least valuable first, most valuable last; ties keep pack order. The pack summary and a reopened pack's ShareSheet show this order too. */
export const revealOrder = <T extends Revealable>(cards: readonly T[]): T[] =>
  cards
    .map((card, i) => ({ card, i }))
    .sort((a, b) => rank(a.card) - rank(b.card) || a.i - b.i)
    .map(({ card }) => card);

/** Flag the first copy of each card the player didn't own before this pack. */
export const markNew = <T extends { key: string }>(cards: readonly T[], owned: (key: string) => boolean): (T & { isNew: boolean })[] => {
  const seen = new Set<string>();
  return cards.map((card) => {
    const isNew = !owned(card.key) && !seen.has(card.key);
    seen.add(card.key);
    return { ...card, isNew };
  });
};

/** Rare and up, and any finish or misprint, get a tell on the card back before the flip and a spotlight after it. */
export const isBigPull = (card: Revealable): boolean =>
  card.rarity === 'RARE' || card.rarity === 'EPIC' || card.rarity === 'LEGENDARY' || card.rarity === 'BRAINROT' || !!card.finish || !!card.misprint;
