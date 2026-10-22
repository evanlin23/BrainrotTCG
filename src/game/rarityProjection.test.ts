import { describe, expect, it } from 'vitest';
import { scoreCards } from '../data/cards';
import { scorePack, type CardDefinition, type PulledCard, type SetDefinition } from '../engine';
import { historyCards, type HistoryEntry } from './history';
import { toCardsWithMeta, type PulledCardLike } from './pulls';
import vectors from '../../spec/vectors.json';
import { checkPull } from './pulls';

const makeSet = (version: number, cards: CardDefinition[]): SetDefinition => ({
  id: 'synthetic-set',
  name: 'Synthetic Set',
  version,
  era: 'Classic',
  cards,
  odds: {
    COMMON: 7000,
    UNCOMMON: 2000,
    RARE: 800,
    EPIC: 150,
    LEGENDARY: 49,
    BRAINROT: 1,
  },
  packSize: 5,
  holoOdds: 500,
  releasedAt: '2025-01-01T00:00:00Z',
});

const v1Cards: CardDefinition[] = [
  { id: 'shared-card', name: 'Shared Card', rarity: 'COMMON' },
  { id: 'historical-only', name: 'Historical Only', rarity: 'RARE' },
  { id: 'filler-1', name: 'Filler 1', rarity: 'COMMON' },
  { id: 'filler-2', name: 'Filler 2', rarity: 'COMMON' },
  { id: 'filler-3', name: 'Filler 3', rarity: 'COMMON' },
];

const v2Cards: CardDefinition[] = [
  { id: 'shared-card', name: 'Shared Card', rarity: 'LEGENDARY' },
  { id: 'filler-1', name: 'Filler 1', rarity: 'COMMON' },
  { id: 'filler-2', name: 'Filler 2', rarity: 'COMMON' },
  { id: 'filler-3', name: 'Filler 3', rarity: 'COMMON' },
  { id: 'new-card', name: 'New Card', rarity: 'EPIC' },
];

const syntheticV1 = makeSet(1, v1Cards);
const syntheticV2 = makeSet(2, v2Cards);

describe('rarity projection for historical packs (#701)', () => {
  it('preserves originating rarity from engine output across different set versions', () => {
    // Engine output for v1 pack
    const v1EngineCards: PulledCard[] = [
      { slot: 0, setId: 'synthetic-set', cardId: 'shared-card', rarity: 'COMMON', isHolo: false },
      { slot: 1, setId: 'synthetic-set', cardId: 'historical-only', rarity: 'RARE', isHolo: false },
      { slot: 2, setId: 'synthetic-set', cardId: 'filler-1', rarity: 'COMMON', isHolo: false },
      { slot: 3, setId: 'synthetic-set', cardId: 'filler-2', rarity: 'COMMON', isHolo: false },
      { slot: 4, setId: 'synthetic-set', cardId: 'filler-3', rarity: 'COMMON', isHolo: false },
    ];
    const v1Score = scorePack(v1EngineCards);

    // Project into UI cards
    const v1Projected = toCardsWithMeta(v1EngineCards, syntheticV1);

    expect(v1Projected[0].id).toBe('shared-card');
    expect(v1Projected[0].rarity).toBe('COMMON');
    expect(v1Projected[1].id).toBe('historical-only');
    expect(v1Projected[1].rarity).toBe('RARE');

    // Projected pack score must agree with the engine pack score
    const v1ProjectedScore = scoreCards(v1Projected);
    expect(v1ProjectedScore.score).toBe(v1Score.score);
    expect(v1ProjectedScore.points).toBe(v1Score.points);

    // Engine output for v2 pack (where shared-card is LEGENDARY)
    const v2EngineCards: PulledCard[] = [
      { slot: 0, setId: 'synthetic-set', cardId: 'shared-card', rarity: 'LEGENDARY', isHolo: false },
      { slot: 1, setId: 'synthetic-set', cardId: 'new-card', rarity: 'EPIC', isHolo: false },
      { slot: 2, setId: 'synthetic-set', cardId: 'filler-1', rarity: 'COMMON', isHolo: false },
      { slot: 3, setId: 'synthetic-set', cardId: 'filler-2', rarity: 'COMMON', isHolo: false },
      { slot: 4, setId: 'synthetic-set', cardId: 'filler-3', rarity: 'COMMON', isHolo: false },
    ];
    const v2Score = scorePack(v2EngineCards);

    const v2Projected = toCardsWithMeta(v2EngineCards, syntheticV2);
    expect(v2Projected[0].id).toBe('shared-card');
    expect(v2Projected[0].rarity).toBe('LEGENDARY');

    const v2ProjectedScore = scoreCards(v2Projected);
    expect(v2ProjectedScore.score).toBe(v2Score.score);
    expect(v2ProjectedScore.points).toBe(v2Score.points);
  });

  it('resolves versioned definition when only a historical reference/cache code is available', () => {
    const rawPulled: PulledCardLike[] = [
      { setId: 'synthetic-set', cardId: 'shared-card', isHolo: false },
      { setId: 'synthetic-set', cardId: 'historical-only', isHolo: false },
    ];

    // When resolving with v1 definition, shared-card is COMMON and historical-only is RARE
    const resolvedV1 = toCardsWithMeta(rawPulled, syntheticV1);
    expect(resolvedV1[0].rarity).toBe('COMMON');
    expect(resolvedV1[1].rarity).toBe('RARE');

    // When resolving with v2 definition, shared-card is LEGENDARY
    const resolvedV2 = toCardsWithMeta(rawPulled, syntheticV2);
    expect(resolvedV2[0].rarity).toBe('LEGENDARY');
  });

  it('retains historical cards removed from newer sets with honest metadata handling', () => {
    // Card 'ghost-card' not defined in any set or catalog
    const ghostPulled: PulledCardLike[] = [
      { setId: 'synthetic-set', cardId: 'ghost-card', rarity: 'UNCOMMON', isHolo: false },
    ];

    const projected = toCardsWithMeta(ghostPulled, syntheticV2);
    expect(projected).toHaveLength(1);
    expect(projected[0].id).toBe('ghost-card');
    expect(projected[0].name).toBe('ghost-card');
    expect(projected[0].rarity).toBe('UNCOMMON');
  });

  it('projects historyCards with versioned rarity and preserves removed cards', () => {
    const entry: HistoryEntry = {
      setId: 'right-now',
      setVersion: 1,
      nonce: 10,
      key: '11'.repeat(8),
      cards: [
        { id: 'huss-valley', holo: false },
        { id: 'sigma', holo: true },
      ],
      hand: 'Pair',
      score: 250,
      openedAt: Date.now(),
    };

    const cards = historyCards(entry);
    expect(cards).not.toBeNull();
    expect(cards!).toHaveLength(2);
    expect(cards![0].id).toBe('huss-valley');
    expect(cards![1].id).toBe('sigma');
    expect(cards![1].isHolo).toBe(true);
  });

  it('keeps existing released vector proofs passing with matching projected score', async () => {
    // Test signed proof vector from spec/vectors.json
    const vector = vectors.valid[0];
    const pull = await checkPull(vector.proof);

    expect(pull.cardsWithMeta).toHaveLength(pull.cards.length);
    for (let i = 0; i < pull.cards.length; i++) {
      expect(pull.cardsWithMeta[i].rarity).toBe(pull.cards[i].rarity);
      expect(pull.cardsWithMeta[i].id).toBe(pull.cards[i].cardId);
      expect(pull.cardsWithMeta[i].isHolo).toBe(pull.cards[i].isHolo);
    }

    const projectedScore = scoreCards(pull.cardsWithMeta);
    expect(projectedScore.score).toBe(pull.score.score);
    expect(projectedScore.points).toBe(pull.score.points);
  });
});
