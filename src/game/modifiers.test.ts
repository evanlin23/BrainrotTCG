import { describe, expect, it } from 'vitest';
import { specialCardsLine } from './modifiers';

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
