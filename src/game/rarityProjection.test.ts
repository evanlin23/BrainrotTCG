import { describe, expect, it, vi } from 'vitest';
import { getCard, scoreCards } from '../data/cards';
import { scorePack, type PulledCard, type SetDefinition } from '../engine';
import { historyCards, type HistoryEntry } from './history';
import { checkPull, toCardsWithMeta, type PulledCardLike } from './pulls';
import vectors from '../../spec/vectors.json';

// Two versions of one set: shared-card is COMMON in v1 and LEGENDARY in v2, historical-only is in v1 alone.
const synthetic = vi.hoisted(() => {
  const makeSet = (version: number, cards: { id: string; name: string; rarity: string }[]) => ({
    id: 'synthetic-set',
    name: 'Synthetic Set',
    version,
    era: 'Classic',
    cards,
    odds: { COMMON: 7000, UNCOMMON: 2000, RARE: 800, EPIC: 150, LEGENDARY: 49, BRAINROT: 1 },
    packSize: 5,
    holoOdds: 500,
    releasedAt: '2025-01-01T00:00:00Z',
    draft: true,
  });
  const fillers = [1, 2, 3].map((n) => ({ id: `filler-${n}`, name: `Filler ${n}`, rarity: 'COMMON' }));
  return {
    v1: makeSet(1, [{ id: 'shared-card', name: 'Shared Card', rarity: 'COMMON' }, { id: 'historical-only', name: 'Historical Only', rarity: 'RARE' }, ...fillers]),
    v2: makeSet(2, [{ id: 'shared-card', name: 'Shared Card', rarity: 'LEGENDARY' }, ...fillers, { id: 'new-card', name: 'New Card', rarity: 'EPIC' }]),
  };
});
vi.mock('../content/sets', async (importOriginal) => {
  const real = await importOriginal<typeof import('../content/sets')>();
  const versions = [...real.ALL_SET_VERSIONS, synthetic.v1, synthetic.v2] as typeof real.ALL_SET_VERSIONS;
  return {
    ...real,
    ALL_SET_VERSIONS: versions,
    getSet: (id: string, version: number) => versions.find((s) => s.id === id && s.version === version),
    getCardDefinition: (setId: string, cardId: string) =>
      versions
        .filter((s) => s.id === setId)
        .sort((a, b) => b.version - a.version)
        .flatMap((s) => s.cards)
        .find((c) => c.id === cardId),
  };
});

const v1 = synthetic.v1 as unknown as SetDefinition;
const v2 = synthetic.v2 as unknown as SetDefinition;
const pulled = (ids: string[], rarities: string[]): PulledCard[] =>
  ids.map((cardId, slot) => ({ slot, setId: 'synthetic-set', cardId, rarity: rarities[slot] as PulledCard['rarity'], isHolo: false }));
const historyEntry = (setVersion: number, ids: string[]): HistoryEntry => ({
  setId: 'synthetic-set', setVersion, nonce: 10, key: '11'.repeat(8), cards: ids.map((id) => ({ id, holo: false })), hand: 'Pair', score: 0, openedAt: 1,
});

describe('rarity projection for historical packs (#701)', () => {
  it('has a catalog that shows the latest rarity, so the tests below prove the version is used', () => {
    expect(getCard('synthetic-set/shared-card')?.rarity).toBe('LEGENDARY');
    expect(getCard('synthetic-set/historical-only')?.rarity).toBe('RARE');
  });

  it('keeps the engine rarity and score for packs from either version', () => {
    const ids = ['shared-card', 'historical-only', 'filler-1', 'filler-2', 'filler-3'];
    const engineV1 = pulled(ids, ['COMMON', 'RARE', 'COMMON', 'COMMON', 'COMMON']);
    const shownV1 = toCardsWithMeta(engineV1, v1);
    expect(shownV1.map((c) => c.rarity)).toEqual(engineV1.map((c) => c.rarity));
    expect(scoreCards(shownV1)).toMatchObject({ score: scorePack(engineV1).score, points: scorePack(engineV1).points });

    const engineV2 = pulled(['shared-card', 'new-card', 'filler-1', 'filler-2', 'filler-3'], ['LEGENDARY', 'EPIC', 'COMMON', 'COMMON', 'COMMON']);
    const shownV2 = toCardsWithMeta(engineV2, v2);
    expect(shownV2.map((c) => c.rarity)).toEqual(engineV2.map((c) => c.rarity));
    expect(scoreCards(shownV2).score).toBe(scorePack(engineV2).score);
  });

  it('takes the rarity from the given set version when the cards carry none', () => {
    const raw: PulledCardLike[] = [{ setId: 'synthetic-set', cardId: 'shared-card', isHolo: false }];
    expect(toCardsWithMeta(raw, v1)[0].rarity).toBe('COMMON');
    expect(toCardsWithMeta(raw, v2)[0].rarity).toBe('LEGENDARY');
  });

  it("throws for a card this build doesn't know, or one not in the given set version, instead of making one up", () => {
    expect(() => toCardsWithMeta([{ setId: 'synthetic-set', cardId: 'ghost-card', rarity: 'UNCOMMON', isHolo: false }])).toThrow(/Unknown card/);
    expect(() => toCardsWithMeta([{ setId: 'synthetic-set', cardId: 'historical-only', isHolo: false }], v2)).toThrow(/Unknown card/);
  });

  it("shows history at its version's rarity, keeps cards later versions dropped, and leaves out what it can't place", () => {
    const fromV1 = historyCards(historyEntry(1, ['shared-card', 'historical-only']))!;
    expect(fromV1.map((c) => [c.id, c.rarity])).toEqual([['shared-card', 'COMMON'], ['historical-only', 'RARE']]);
    expect(historyCards(historyEntry(2, ['shared-card']))!.map((c) => c.rarity)).toEqual(['LEGENDARY']);
    // Not in v2, and no rarity borrowed from the latest version for a version this build doesn't know.
    expect(historyCards(historyEntry(2, ['historical-only', 'ghost-card']))).toEqual([]);
    expect(historyCards(historyEntry(3, ['shared-card']))).toEqual([]);
  });

  it('keeps released vector proofs showing the rarity and score they were signed with', async () => {
    const pull = await checkPull(vectors.valid[0].proof);
    expect(pull.cardsWithMeta.map((c) => [c.id, c.rarity, c.isHolo])).toEqual(pull.cards.map((c) => [c.cardId, c.rarity, c.isHolo]));
    expect(scoreCards(pull.cardsWithMeta)).toMatchObject({ score: pull.score.score, points: pull.score.points });
  });
});
