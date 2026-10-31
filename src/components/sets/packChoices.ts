import type { SetDefinition } from '../../engine';
import { isNewSet } from '../../content/sets';
import type { CollectionItem } from '../../types';
import { setProgress } from '../../game/progression';
import { isCardOwned } from '../../game/versions';

/** How much of a set the collection holds, and its Complete or Master badge. */
export const progressOf = (set: SetDefinition, collection: Record<string, CollectionItem>) => {
  const owned = set.cards.filter((c) => isCardOwned(collection[`${set.id}/${c.id}`])).length;
  const holoOwned = set.cards.filter((c) => (collection[`${set.id}/${c.id}`]?.holoCount ?? 0) > 0).length;
  return { owned, size: set.cards.length, done: setProgress(owned, holoOwned, set.cards.length) };
};

/** The most wrappers the summary's "Try another pack" shows. */
export const PACK_CHOICE_THUMBS = 2;

/**
 * The other packs a player can choose, for the summary's "Try another pack": `count` is every other set
 * the picker lists, and `preview` the (at most two) wrappers to show. A new drop comes first, then sets
 * the player hasn't finished, then the rest; newer before older within each. `sets` is the picker's own
 * list (timeline order, oldest first), so a hidden or draft set appears only where the picker shows it.
 */
export const otherPackChoices = (sets: SetDefinition[], selectedId: string, collection: Record<string, CollectionItem>) => {
  const others = sets.filter((s) => s.id !== selectedId);
  const rank = (s: SetDefinition) => {
    const { owned, size } = progressOf(s, collection);
    return (isNewSet(s) ? 0 : 2) + (owned < size ? 0 : 1);
  };
  const preview = others
    .map((set, index) => ({ set, index, rank: rank(set) }))
    .sort((a, b) => a.rank - b.rank || b.index - a.index)
    .slice(0, PACK_CHOICE_THUMBS)
    .map((entry) => entry.set);
  return { count: others.length, preview };
};
