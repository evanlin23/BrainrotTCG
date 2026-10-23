/**
 * How card modifiers (spec section 5.4) look in the game: names, colours and labels. The odds and
 * points live in the engine; a set opts in with `"modifiers": 1`.
 */
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
 * An owned version in words for the close-up's chips and stats: "Plain" when it has no modifiers, and
 * "(uncertain)" after a version rebuilt from tallies that fit more than one combination.
 */
export const versionName = (version: { isHolo?: boolean; finish?: Finish | null; misprint?: boolean; uncertain?: boolean }): string =>
  `${modifierLabel(version) || 'Plain'}${version.uncertain ? ' (uncertain)' : ''}`;

/** The rarest finish in a tally of finishes owned, if any. */
export const bestFinish = (finishes?: Partial<Record<Finish, number>>): Finish | undefined => FINISHES_RAREST_FIRST.find((f) => (finishes?.[f] ?? 0) > 0);

/** Classes for a card's face: `finish-gold misprint` and so on. */
export const modifierClasses = (card: { finish?: Finish | null; misprint?: boolean }): string =>
  [card.finish && `finish-${card.finish.toLowerCase()}`, card.misprint && 'misprint'].filter(Boolean).join(' ');

/** Inline style values with no UI-library types: a plain map a component passes to `style`. */
export type StyleVars = Record<string, string | number>;

/** Props for a thumbnail's wrapper: the modifier classes plus the finish colour as `--finish`. */
export const modifierThumb = (card: { finish?: Finish | null; misprint?: boolean }) => ({
  className: `mod-thumb ${modifierClasses(card)}`,
  style: (card.finish ? { '--finish': FINISH_INFO[card.finish].color } : undefined) as StyleVars | undefined,
});
