import { describe, expect, it } from 'vitest';
import { decodeCard, encodeCard, isCardCode, modifiersFor } from './cardCode';

describe('stored cards', () => {
  it('round-trips every combination', () => {
    for (const holo of [false, true]) {
      for (const finish of [undefined, 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'] as const) {
        for (const misprint of [false, true]) {
          const card = { id: 'ok-i-pull-up', holo, ...(finish ? { finish } : {}), ...(misprint ? { misprint } : {}) };
          expect(decodeCard(encodeCard(card))).toEqual(card);
        }
      }
    }
    expect(encodeCard({ id: 'sigma', holo: true, finish: 'GOLD', misprint: true })).toBe('sigma*G!');
  });

  it('reads records from before modifiers', () => {
    expect(decodeCard('rizz')).toEqual({ id: 'rizz', holo: false });
    expect(decodeCard('rizz*')).toEqual({ id: 'rizz', holo: true });
  });

  it('tells a code it can read from one it would fail on', () => {
    for (const code of ['rizz', 'rizz*', 'sigma*G!', 'ok-i-pull-up!']) expect(isCardCode(code)).toBe(true);
    // decodeCard throws on a line break; a comma or an empty id isn't one card.
    for (const code of ['sigma\n', 'sig\rma', 'sigma\u2028', '\u2029sigma', 'a,b', '', '*G!']) expect(isCardCode(code)).toBe(false);
  });

  it('gives modifier sets explicit "none"', () => {
    expect(modifiersFor({ id: 'a', holo: false }, true)).toEqual({ finish: null, misprint: false });
    expect(modifiersFor({ id: 'a', holo: false, finish: 'GOLD' }, false)).toEqual({});
  });
});
