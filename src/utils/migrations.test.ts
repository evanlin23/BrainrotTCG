import { describe, expect, it } from 'vitest';
import { ALL_CARDS, getCard, type Card } from '../data/cards';
import { hydrateCollection } from './migrations';

const current = ALL_CARDS[0];
const unknown: Card = {
  key: 'retired/missing-card', setId: 'retired', id: 'missing-card',
  name: 'Historical card', rarity: 'RARE', image: '/historical.webp',
  caption: 'Stored caption', flavor: 'Stored flavor',
};

describe('collection hydration', () => {
  it.each([null, undefined, false, 42, 'collection', [], [{ card: current }]])('ignores a non-map container: %j', (value) => {
    expect(hydrateCollection(value)).toEqual({});
  });

  it('retains readable entries beside malformed records without changing map keys or counts', () => {
    const retained = {
      card: { id: current.id, key: current.key }, normalCount: 3, holoCount: 2,
      count: 8, finishes: { GOLD: 1 }, misprints: 1, modifierPoints: 7,
    };
    const malformed = [
      null, undefined, false, 0, '', [], {},
      { card: null }, { card: 1 }, { card: [] }, { card: 'card' },
      { card: {} }, { card: { id: null } }, { card: { id: 4 } },
      { card: { id: [] } }, { card: { id: {} } },
      { card: { id: current.id, key: 4 } },
    ];
    const collection = { retained, ...Object.fromEntries(malformed.map((value, index) => [`bad-${index}`, value])) };
    expect(hydrateCollection(collection)).toEqual({ retained: { ...retained, card: current } });
  });

  it('refreshes a known card from the registry and retains unrelated stored card metadata', () => {
    const card = { ...current, name: 'Stale name', image: '/stale.webp', note: 'Keep this metadata' };
    expect(hydrateCollection({ originalKey: { card, normalCount: 1, holoCount: 0 } })).toEqual({
      originalKey: { card: { ...current, note: 'Keep this metadata' }, normalCount: 1, holoCount: 0 },
    });
  });

  it('resolves a legacy image-file ID without replacing its original collection key', () => {
    const legacyCard = getCard('genesis/chimpanzini-bananini');
    expect(legacyCard).toBeDefined();
    expect(hydrateCollection({ image: { card: { id: 'image' }, count: 2 } })).toEqual({
      image: { card: legacyCard, count: 2 },
    });
  });

  it('retains a complete unknown historical card, including the fallback for a missing key', () => {
    const { key: _key, ...withoutKey } = unknown;
    expect(hydrateCollection({
      explicit: { card: unknown, normalCount: 1, holoCount: 1 },
      fallback: { card: withoutKey, normalCount: 2, holoCount: 0 },
    })).toEqual({
      explicit: { card: unknown, normalCount: 1, holoCount: 1 },
      fallback: { card: { ...withoutKey, key: 'genesis/missing-card' }, normalCount: 2, holoCount: 0 },
    });
  });

  it('skips unknown records whose display fields cannot be read safely', () => {
    const invalid = [
      { id: 'missing' }, { ...unknown, name: {} }, { ...unknown, image: null },
      { ...unknown, setId: false }, { ...unknown, rarity: 'NONEXISTENT' },
      { ...unknown, rarity: 'toString' }, { ...unknown, caption: {} }, { ...unknown, flavor: [] },
    ];
    expect(hydrateCollection(Object.fromEntries(invalid.map((card, index) => [String(index), { card }])))).toEqual({});
  });

  it('does not mutate the parsed input or remove corrupt records from the original saved payload', () => {
    const raw = JSON.stringify({
      keep: { card: { id: current.id, key: current.key }, normalCount: 1, holoCount: 0 },
      corrupt: null,
    });
    const parsed = JSON.parse(raw);
    Object.freeze(parsed.keep.card);
    Object.freeze(parsed.keep);
    Object.freeze(parsed);
    const hydrated = hydrateCollection(parsed);
    expect(hydrated.keep.card).toEqual(current);
    expect(hydrated).not.toHaveProperty('corrupt');
    expect(JSON.stringify(parsed)).toBe(raw);
    expect(parsed.corrupt).toBeNull();
    expect(hydrated.keep).not.toBe(parsed.keep);
  });
});
