import { describe, expect, it } from 'vitest';
import { SETS, isNewSet, isOpenable } from '../../content/sets';
import type { SetDefinition } from '../../engine';
import type { CollectionItem } from '../../types';
import { changePackCount, otherPackChoices } from './packChoices';

const openable = SETS.filter(isOpenable);
const ownAll = (set: SetDefinition): Record<string, CollectionItem> =>
  Object.fromEntries(set.cards.map((card) => [`${set.id}/${card.id}`, { card, normalCount: 1, holoCount: 0 } as unknown as CollectionItem]));

describe('otherPackChoices', () => {
  it('counts every other listed set and never offers the selected one', () => {
    const selected = openable[0];
    const { count, preview } = otherPackChoices(openable, selected.id, {});
    expect(count).toBe(openable.length - 1);
    expect(preview.every((s) => s.id !== selected.id)).toBe(true);
    expect(preview.length).toBe(Math.min(2, count));
  });

  it('has nothing to offer with one set', () => {
    expect(otherPackChoices([openable[0]], openable[0].id, {})).toEqual({ count: 0, preview: [] });
  });

  it('shows unfinished sets before finished ones, and the newer of two equals first', () => {
    const [a, b, c, d] = openable.filter((s) => !isNewSet(s)).slice(-4);
    // The newest set is finished; the two just before it are not: the finished one drops behind them.
    const collection = ownAll(d);
    const { preview } = otherPackChoices([a, b, c, d], 'nothing-selected', collection);
    expect(preview.map((s) => s.id)).toEqual([c.id, b.id]);
  });
});

describe('changePackCount', () => {
  const selectedId = openable[0].id;
  it('offers every other listed set to a returning player who has not seen the Packs sheet', () => {
    expect(changePackCount({ returning: true, seen: false, sets: openable, selectedId })).toBe(openable.length - 1);
    // The same number the summary's "Try another pack" counts: one list, the picker's.
    expect(changePackCount({ returning: true, seen: false, sets: openable, selectedId })).toBe(otherPackChoices(openable, selectedId, {}).count);
  });

  it('offers nothing to a new player, once the sheet has been seen, or with one set', () => {
    expect(changePackCount({ returning: false, seen: false, sets: openable, selectedId })).toBe(0);
    expect(changePackCount({ returning: true, seen: true, sets: openable, selectedId })).toBe(0);
    expect(changePackCount({ returning: true, seen: false, sets: [openable[0]], selectedId })).toBe(0);
  });

  it('counts only the sets the picker lists, so a set it leaves out (a draft, say) is not counted', () => {
    const listed = openable.slice(0, 3);
    expect(changePackCount({ returning: true, seen: false, sets: listed, selectedId: listed[1].id })).toBe(2);
  });
});
