/**
 * How a pack is shown, not what it is: the pack's cards, proof and history keep the engine's
 * order. Like the rare slot in a real booster, the best card comes last.
 */
import { cardPoints, type Finish, type Rarity } from '../engine';
import { setProgress } from './progression';

export interface TakeoverSetContext {
  /** How many unique cards the player owns in this set (including this card if new). */
  owned?: number;
  /** Unique cards owned in this set before this reveal. */
  ownedBefore?: number;
  /** Total cards in this set. */
  size?: number;
  /** How many holos the player owns in this set. */
  holoOwned?: number;
  cards?: readonly unknown[];
  id?: string;
}

export interface TakeoverCollectionContext {
  /** How many unique collectible cards the player owns (including this card if new). */
  owned?: number;
  /** Unique collectible cards owned before this reveal. */
  ownedBefore?: number;
  /** Total collectible cards in the collection. */
  total?: number;
}

export interface TakeoverContext {
  set?: TakeoverSetContext;
  collection?: TakeoverCollectionContext;
  setOwned?: number;
  setOwnedBefore?: number;
  setSize?: number;
  setHoloOwned?: number;
  collectionOwned?: number;
  collectionOwnedBefore?: number;
  collectionTotal?: number;
  setComplete?: boolean;
  collectionComplete?: boolean;
}

export type TakeoverCard = {
  rarity: Rarity;
  isNew?: boolean;
  isHolo?: boolean;
  finish?: Finish | null;
  misprint?: boolean;
};

type Revealable = { rarity: Rarity; isHolo: boolean; finish?: Finish | null; misprint?: boolean };

/** What the card is worth: rarity times holo, finish and misprint, so a Platinum Common outranks a plain Rare. */
const rank = (card: Revealable) => cardPoints(card.rarity, card.isHolo, card.finish, card.misprint);

/** Individual card value, before any pack combo multiplier. The cutoff itself qualifies, as does any card of Brainrot rarity. */
export const SPECIAL_REVEAL_CUTOFF = 5_000;
export const SPECIAL_REVEAL_DURATION_MS = 3_000;
export const isSpecialReveal = (card: Revealable): boolean => card.rarity === 'BRAINROT' || rank(card) >= SPECIAL_REVEAL_CUTOFF;

/**
 * Cinematic takeover reveal trigger (Spec 1, #1293).
 *
 * Returns true when the card is of Brainrot rarity, or is a new card that completes its set,
 * or completes the collection. Points alone never trigger it (even if 10,000+ points).
 * Evaluates completion via the same set-progress helper the Collection page uses (`setProgress`).
 */
export const isTakeoverReveal = (card: TakeoverCard, context?: TakeoverContext): boolean => {
  if (card.rarity === 'BRAINROT') {
    return true;
  }

  // Points alone never trigger the takeover. Only a new card can complete a set or collection.
  if (!card.isNew || !context) {
    return false;
  }

  if (context.setComplete) {
    return true;
  }

  const setOwnedBefore = context.set?.ownedBefore ?? context.setOwnedBefore;
  const setOwned = context.set?.owned ?? context.setOwned ?? (setOwnedBefore !== undefined ? setOwnedBefore + 1 : undefined);
  const setSize = (context.set && 'size' in context.set && typeof context.set.size === 'number' ? context.set.size : undefined)
    ?? (context.set && 'cards' in context.set && Array.isArray(context.set.cards) ? context.set.cards.length : undefined)
    ?? context.setSize;
  const setHolo = context.set?.holoOwned ?? context.setHoloOwned ?? 0;

  if (setOwned !== undefined && setSize !== undefined) {
    if (setProgress(setOwned, setHolo, setSize) !== null) {
      return true;
    }
  }

  if (context.collectionComplete) {
    return true;
  }

  const collectionOwnedBefore = context.collection?.ownedBefore ?? context.collectionOwnedBefore;
  const collectionOwned = context.collection?.owned ?? context.collectionOwned ?? (collectionOwnedBefore !== undefined ? collectionOwnedBefore + 1 : undefined);
  const collectionTotal = (context.collection && 'total' in context.collection && typeof context.collection.total === 'number' ? context.collection.total : undefined)
    ?? context.collectionTotal;

  if (collectionOwned !== undefined && collectionTotal !== undefined) {
    if (setProgress(collectionOwned, 0, collectionTotal) !== null) {
      return true;
    }
  }

  return false;
};

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
