import { FINISHES_RAREST_FIRST, RARITIES_RAREST_FIRST, type Finish, type Rarity } from '../engine';
import { bestFinish } from './modifiers';

/** The copies of one card the filters look at; an unowned card has none (`undefined`). */
export interface FilterableCounts {
  holoCount: number;
  finishes?: Partial<Record<Finish, number>>;
}

/** The Cards page's search and filter controls (#756). */
export interface CollectionFilters {
  /** Part of a card's name, any case; blank matches every card. */
  query: string;
  rarity: Rarity | 'ALL';
  /** `ANY` is any finish at all; `ALL` doesn't look at finishes. */
  finish: Finish | 'ANY' | 'ALL';
  /** Only cards you own at least one holo copy of. */
  holoOnly: boolean;
  /** Only cards you don't own. */
  missingOnly: boolean;
}

export const NO_FILTERS: CollectionFilters = { query: '', rarity: 'ALL', finish: 'ALL', holoOnly: false, missingOnly: false };

/** Rarity choices for the control, commonest first (the order a binder prints them). */
export const RARITY_CHOICES: readonly Rarity[] = [...RARITIES_RAREST_FIRST].reverse();
/** Finish choices for the control, silver (commonest) first. */
export const FINISH_CHOICES: readonly Finish[] = [...FINISHES_RAREST_FIRST].reverse();

/** Whether any control narrows the binder. */
export const isFiltering = (f: CollectionFilters): boolean =>
  f.query.trim() !== '' || f.rarity !== 'ALL' || f.finish !== 'ALL' || f.holoOnly || f.missingOnly;

/**
 * Whether a card passes every active filter. Pure: `counts` is what the player owns of it
 * (undefined when nothing), already decided by the caller's ownership rules. Whether a pocket is
 * shown at all (draft and archived sets show only owned cards) stays the binder's call, so a filter
 * can't reveal a card the unfiltered binder hides.
 */
export const cardMatches = (card: { name: string; rarity: Rarity }, counts: FilterableCounts | undefined, f: CollectionFilters): boolean => {
  const query = f.query.trim().toLowerCase();
  if (query && !card.name.toLowerCase().includes(query)) return false;
  if (f.rarity !== 'ALL' && card.rarity !== f.rarity) return false;
  if (f.missingOnly && counts) return false;
  if (f.holoOnly && !(counts && counts.holoCount > 0)) return false;
  if (f.finish === 'ANY') return !!bestFinish(counts?.finishes);
  if (f.finish !== 'ALL') return (counts?.finishes?.[f.finish] ?? 0) > 0;
  return true;
};
