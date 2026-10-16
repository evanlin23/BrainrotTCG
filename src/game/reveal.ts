/**
 * How a pack is shown, not what it is: the pack's cards, proof and history keep the engine's
 * order. Like the rare slot in a real booster, the best card comes last.
 */
import { cardPoints, type Finish, type Rarity } from '../engine';

type Revealable = { rarity: Rarity; isHolo: boolean; finish?: Finish | null; misprint?: boolean };

/** What the card is worth: rarity times holo, finish and misprint, so a Platinum Common outranks a plain Rare. */
const rank = (card: Revealable) => cardPoints(card.rarity, card.isHolo, card.finish, card.misprint);

/** Individual card value, before any pack combo multiplier. The cutoff itself qualifies. */
export const SPECIAL_REVEAL_CUTOFF = 5_000;
export const SPECIAL_REVEAL_DURATION_MS = 3_000;
export const isSpecialReveal = (card: Revealable): boolean => rank(card) >= SPECIAL_REVEAL_CUTOFF;

/** Skip can pass ordinary cards, but every still-hidden valuable card must get its own reveal. */
export const nextSpecialRevealIndex = (cards: readonly (Revealable & { isRevealed: boolean })[]): number =>
  cards.findIndex((card) => !card.isRevealed && isSpecialReveal(card));

/** Least valuable first, most valuable last; ties keep pack order. */
export const revealOrder = <T extends Revealable>(cards: readonly T[]): T[] =>
  cards
    .map((card, i) => ({ card, i }))
    .sort((a, b) => rank(a.card) - rank(b.card) || a.i - b.i)
    .map(({ card }) => card);

/**
 * The pack summary's order, exactly the reveal's reversed: the best pull first, and on ties the later
 * card first, so the summary opens on the card the reveal ended on (the pack's best card).
 */
export const bestPullOrder = <T extends Revealable>(cards: readonly T[]): T[] =>
  cards
    .map((card, i) => ({ card, i }))
    .sort((a, b) => rank(b.card) - rank(a.card) || b.i - a.i)
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
