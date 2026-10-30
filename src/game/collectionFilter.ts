import { FINISHES_RAREST_FIRST, RARITIES_RAREST_FIRST, type Finish, type Rarity } from '../engine';
import { bestFinish } from './modifiers';

/** The copies of one card the filters look at; an unowned card has none (`undefined`). */
export interface FilterableCounts {
  holoCount: number;
  finishes?: Partial<Record<Finish, number>>;
}

/** Whether to show all cards, only owned cards, or cards not found yet (#756). */
export type ShowFilter = 'ALL' | 'OWNED' | 'NOT_FOUND_YET';

/** The Cards page's search and filter controls (#756). */
export interface CollectionFilters {
  /** Part of a card's name, any case; blank matches every card. */
  query: string;
  rarity: Rarity | 'ALL';
  /** `ANY` is any finish at all; `ALL` doesn't look at finishes. */
  finish: Finish | 'ANY' | 'ALL';
  /** Only cards you own at least one holo copy of. */
  holoOnly: boolean;
  /** Whether to show all cards, only owned cards, or cards not found yet. */
  show: ShowFilter;
}

export const NO_FILTERS: CollectionFilters = { query: '', rarity: 'ALL', finish: 'ALL', holoOnly: false, show: 'ALL' };

/** Rarity choices for the control, commonest first (the order a binder prints them). */
export const RARITY_CHOICES: readonly Rarity[] = [...RARITIES_RAREST_FIRST].reverse();
/** Finish choices for the control, silver (commonest) first. */
export const FINISH_CHOICES: readonly Finish[] = [...FINISHES_RAREST_FIRST].reverse();

/** Whether any control narrows the binder. */
export const isFiltering = (f: CollectionFilters): boolean =>
  f.query.trim() !== '' || f.rarity !== 'ALL' || f.finish !== 'ALL' || f.holoOnly || f.show !== 'ALL';

/**
 * Explains why an impossible combination of active filters cannot match any card,
 * or returns null if the filters can match in principle.
 */
export const impossibleFilterReason = (f: CollectionFilters): string | null => {
  if (f.show === 'NOT_FOUND_YET') {
    if (f.holoOnly && f.finish !== 'ALL') {
      return "Cards not found yet cannot be holo or have a finish.";
    }
    if (f.holoOnly) {
      return "Cards not found yet cannot be holo.";
    }
    if (f.finish !== 'ALL') {
      return "Cards not found yet cannot have a finish.";
    }
  }
  return null;
};

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
  if (f.show === 'NOT_FOUND_YET' && counts) return false;
  if (f.show === 'OWNED' && !counts) return false;
  if (f.holoOnly && !(counts && counts.holoCount > 0)) return false;
  if (f.finish === 'ANY') return !!bestFinish(counts?.finishes);
  if (f.finish !== 'ALL') return (counts?.finishes?.[f.finish] ?? 0) > 0;
  return true;
};
