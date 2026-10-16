/**
 * How card modifiers (spec section 5.4) look in the game: names, colours and labels. The odds and
 * points live in the engine; a set opts in with `"modifiers": 1`.
 */
import type React from 'react';
import { FINISHES_RAREST_FIRST, type Finish } from '../engine';
import { FINISH_COLORS } from '../styles/palette';
import '../styles/Modifiers.css';

export const FINISH_INFO: Record<Finish, { name: string; color: string }> = {
  SILVER: { name: 'Silver', color: FINISH_COLORS.SILVER },
  GOLD: { name: 'Gold', color: FINISH_COLORS.GOLD },
  PLATINUM: { name: 'Platinum', color: FINISH_COLORS.PLATINUM },
  DIAMOND: { name: 'Diamond', color: FINISH_COLORS.DIAMOND },
};

/** What makes a card special beyond its rarity, e.g. "Gold · Holo · Misprint" ('' if nothing). */
export const modifierLabel = (card: { isHolo?: boolean; finish?: Finish | null; misprint?: boolean }, withHolo = true): string =>
  [card.finish && FINISH_INFO[card.finish].name, withHolo && card.isHolo && 'Holo', card.misprint && 'Misprint'].filter(Boolean).join(' · ');

/**
 * The pack summary's line about its special cards, e.g. "2 special cards · Gold, Holo": how many are
 * holo, finished or misprinted, and which of those kinds turned up, finishes rarest first. Null if
 * none did.
 */
export const specialCardsLine = (cards: readonly { isHolo?: boolean; finish?: Finish | null; misprint?: boolean }[]): string | null => {
  const special = cards.filter((c) => c.isHolo || c.finish || c.misprint);
  if (special.length === 0) return null;
  const kinds = [
    ...FINISHES_RAREST_FIRST.filter((f) => special.some((c) => c.finish === f)).map((f) => FINISH_INFO[f].name),
    ...(special.some((c) => c.isHolo) ? ['Holo'] : []),
    ...(special.some((c) => c.misprint) ? ['Misprint'] : []),
  ];
  return `${special.length} special ${special.length === 1 ? 'card' : 'cards'} · ${kinds.join(', ')}`;
};

/** The rarest finish in a tally of finishes owned, if any. */
export const bestFinish = (finishes?: Partial<Record<Finish, number>>): Finish | undefined => FINISHES_RAREST_FIRST.find((f) => (finishes?.[f] ?? 0) > 0);

/** Classes for a card's face: `finish-gold misprint` and so on. */
export const modifierClasses = (card: { finish?: Finish | null; misprint?: boolean }): string =>
  [card.finish && `finish-${card.finish.toLowerCase()}`, card.misprint && 'misprint'].filter(Boolean).join(' ');

/** Props for a thumbnail's wrapper: the modifier classes plus the finish colour as `--finish`. */
export const modifierThumb = (card: { finish?: Finish | null; misprint?: boolean }) => ({
  className: `mod-thumb ${modifierClasses(card)}`,
  style: (card.finish ? { '--finish': FINISH_INFO[card.finish].color } : undefined) as React.CSSProperties | undefined,
});
