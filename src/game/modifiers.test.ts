import { describe, expect, it } from 'vitest';
import { getLatestSet } from '../content/sets';
import { specialCardsLine, specialPackChance } from './modifiers';

describe('specialCardsLine', () => {
  it('is null when no card is holo, finished or misprinted', () => {
    expect(specialCardsLine([])).toBeNull();
    expect(specialCardsLine([{ isHolo: false, finish: null, misprint: false }, {}])).toBeNull();
  });

  it('counts special cards and lists each kind once, finishes rarest first, then holo and misprint', () => {
    expect(specialCardsLine([{ isHolo: true }, {}])).toBe('1 special card · Holo');
    expect(specialCardsLine([
      { finish: 'SILVER', misprint: true },
      { isHolo: true, finish: 'DIAMOND' },
      { isHolo: true },
      {},
    ])).toBe('3 special cards · Diamond, Silver, Holo, Misprint');
  });
});

describe('specialPackChance', () => {
  it('is one minus the chance every card misses holo, a finish and a misprint', () => {
    // 5% holo, 13.1% any finish (10 + 50 + 250 + 1000 of 10,000), 0.5% misprint, 5 cards.
    const plainCard = 0.95 * (1 - 0.131) * 0.995;
    expect(specialPackChance({ holoOdds: 500, packSize: 5, modifiers: 1 })).toBeCloseTo(1 - plainCard ** 5, 12);
  });

  it('counts only holo for sets without modifiers', () => {
    expect(specialPackChance({ holoOdds: 500, packSize: 5 })).toBeCloseTo(1 - 0.95 ** 5, 12);
    expect(specialPackChance({ holoOdds: 0, packSize: 5 })).toBe(0);
  });

  it('gives about 63% for a released set with modifiers', () => {
    const set = getLatestSet('right-now')!;
    expect(set.modifiers).toBe(1);
    expect(Math.round(specialPackChance(set) * 100)).toBe(63);
  });
});
