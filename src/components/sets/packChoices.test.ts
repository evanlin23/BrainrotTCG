import { describe, expect, it } from 'vitest';
import { SETS, isNewSet, isOpenable } from '../../content/sets';
import type { SetDefinition } from '../../engine';
import type { CollectionItem } from '../../types';
import { otherPackChoices } from './packChoices';

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
