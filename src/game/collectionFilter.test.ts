import { describe, expect, it } from 'vitest';
import { cardMatches, FINISH_CHOICES, isFiltering, NO_FILTERS, RARITY_CHOICES, type CollectionFilters } from './collectionFilter';

const card = { name: 'Bukangi Bombardino', rarity: 'RARE' } as const;
const plain = { holoCount: 0 };
const holo = { holoCount: 2 };
const gold = { holoCount: 0, finishes: { GOLD: 1 } };
const silverHolo = { holoCount: 1, finishes: { SILVER: 2, DIAMOND: 0 } };
const f = (change: Partial<CollectionFilters>): CollectionFilters => ({ ...NO_FILTERS, ...change });

describe('isFiltering', () => {
  it('is off for the defaults and for a blank search, on for any one control', () => {
    expect(isFiltering(NO_FILTERS)).toBe(false);
    expect(isFiltering(f({ query: '  ' }))).toBe(false);
    for (const change of [{ query: 'a' }, { rarity: 'RARE' }, { finish: 'ANY' }, { finish: 'GOLD' }, { holoOnly: true }, { missingOnly: true }] as const) {
      expect(isFiltering(f(change))).toBe(true);
    }
  });
});

describe('cardMatches', () => {
  it('matches everything with no filters, owned or not', () => {
    expect(cardMatches(card, undefined, NO_FILTERS)).toBe(true);
    expect(cardMatches(card, plain, NO_FILTERS)).toBe(true);
  });

  it('searches part of the name, ignoring case and outer spaces', () => {
    expect(cardMatches(card, plain, f({ query: ' BOMBA ' }))).toBe(true);
    expect(cardMatches(card, undefined, f({ query: 'bukangi' }))).toBe(true);
    expect(cardMatches(card, plain, f({ query: 'tung' }))).toBe(false);
  });

  it('filters by rarity, owned or not', () => {
    expect(cardMatches(card, undefined, f({ rarity: 'RARE' }))).toBe(true);
    expect(cardMatches(card, plain, f({ rarity: 'EPIC' }))).toBe(false);
  });

  it('holo only needs a holo copy', () => {
    expect(cardMatches(card, holo, f({ holoOnly: true }))).toBe(true);
    expect(cardMatches(card, plain, f({ holoOnly: true }))).toBe(false);
    expect(cardMatches(card, undefined, f({ holoOnly: true }))).toBe(false);
  });

  it('missing only needs no copy at all', () => {
    expect(cardMatches(card, undefined, f({ missingOnly: true }))).toBe(true);
    expect(cardMatches(card, plain, f({ missingOnly: true }))).toBe(false);
  });

  it('finish: any finish, one finish, and a finish tallied at zero', () => {
    expect(cardMatches(card, gold, f({ finish: 'ANY' }))).toBe(true);
    expect(cardMatches(card, plain, f({ finish: 'ANY' }))).toBe(false);
    expect(cardMatches(card, undefined, f({ finish: 'ANY' }))).toBe(false);
    expect(cardMatches(card, gold, f({ finish: 'GOLD' }))).toBe(true);
    expect(cardMatches(card, gold, f({ finish: 'SILVER' }))).toBe(false);
    expect(cardMatches(card, silverHolo, f({ finish: 'DIAMOND' }))).toBe(false);
    expect(cardMatches(card, silverHolo, f({ finish: 'SILVER' }))).toBe(true);
  });

  it('every filter must pass, and contradictory ones match nothing', () => {
    expect(cardMatches(card, silverHolo, f({ query: 'buk', rarity: 'RARE', finish: 'ANY', holoOnly: true }))).toBe(true);
    expect(cardMatches(card, silverHolo, f({ query: 'buk', rarity: 'RARE', finish: 'GOLD', holoOnly: true }))).toBe(false);
    for (const counts of [undefined, plain, holo]) expect(cardMatches(card, counts, f({ holoOnly: true, missingOnly: true }))).toBe(false);
    expect(cardMatches(card, undefined, f({ finish: 'ANY', missingOnly: true }))).toBe(false);
  });
});

describe('choices', () => {
  it('list rarities and finishes commonest first', () => {
    expect(RARITY_CHOICES).toEqual(['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'BRAINROT']);
    expect(FINISH_CHOICES).toEqual(['SILVER', 'GOLD', 'PLATINUM', 'DIAMOND']);
  });
});
