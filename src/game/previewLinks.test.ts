import { describe, expect, it } from 'vitest';
import { FINISHES_RAREST_FIRST, MODIFIERS_V1, POKER_HANDS, type HandKey } from '../engine';
import { ALL_SET_VERSIONS } from '../content/sets';
import {
  cardPreviewPath,
  compareCardIds,
  hasModifierPages,
  headline,
  MODIFIER_TOKENS,
  modifierTokens,
  PACK_HEADLINE_TOKENS,
  PREVIEW_COPIES,
  previewImagePath,
  previewOf,
  previewPath,
  previewTitle,
  type ModifierToken,
} from './previewLinks';

const pack = (...ids: string[]) => ids.map((id) => ({ key: `right-now/${id}` }));

describe('link previews', () => {
  it('shows the cards that make the hand', () => {
    expect(previewOf(pack('a', 'b', 'a', 'b', 'a'))).toEqual({ setId: 'right-now', cardIds: ['a', 'b'], hand: 'FULL_HOUSE' });
    expect(previewOf(pack('b', 'a', 'b', 'b', 'a'))).toEqual({ setId: 'right-now', cardIds: ['b', 'a'], hand: 'FULL_HOUSE' }); // the three first
    expect(previewOf(pack('z', 'y', 'c', 'z', 'y'))?.cardIds).toEqual(['y', 'z']); // Two Pair: one picture per pair of cards
    expect(previewOf(pack('q', 'a', 'a', 'a', 'a'))).toEqual({ setId: 'right-now', cardIds: ['a'], hand: 'FOUR_OF_A_KIND' });
    expect(previewOf(pack('a', 'b', 'c', 'c', 'd'))).toEqual({ setId: 'right-now', cardIds: ['c'], hand: 'PAIR' });
    // Nothing matches: the last card, which is the best once sorted by revealOrder.
    expect(previewOf(pack('a', 'b', 'c', 'd', 'e'))).toEqual({ setId: 'right-now', cardIds: ['e'], hand: 'NO_MATCH' });
    expect(previewOf([])).toBeUndefined();
  });

  it('lays out exactly a pack for every hand', () => {
    for (const hand of Object.keys(POKER_HANDS) as HandKey[]) expect(PREVIEW_COPIES[hand].reduce((a, b) => a + b)).toBeLessThanOrEqual(5);
    expect(PREVIEW_COPIES.FULL_HOUSE).toEqual([3, 2]);
  });

  it('keeps the addresses of links already shared', () => {
    // One-card hands hash as "set/card/HAND", like the earlier pages.
    expect(previewPath({ setId: 'right-now', cardIds: ['jimothy'], hand: 'FULL_HOUSE' })).toMatch(/^p\/[0-9a-f]{8}\.html$/);
    expect(previewPath({ setId: 'right-now', cardIds: ['jimothy', 'a'], hand: 'FULL_HOUSE' })).not.toBe(previewPath({ setId: 'right-now', cardIds: ['jimothy'], hand: 'FULL_HOUSE' }));
    expect(cardPreviewPath('right-now', 'jimothy')).toMatch(/^p\/[0-9a-f]{8}\.html$/);
    // Codes already out in shared links, pinned: they must never change.
    expect(cardPreviewPath('right-now', 'jimothy')).toBe('p/9157df58.html');
    expect(cardPreviewPath('gen-alpha-uprising', 'skibidi-toilet')).toBe('p/548ba4ad.html');
    expect(previewPath({ setId: 'right-now', cardIds: ['a', 'jimothy'], hand: 'TWO_PAIR' })).toBe('p/b7c4790b.html');
    expect(previewPath({ setId: 'right-now', cardIds: ['jimothy'], hand: 'FULL_HOUSE' })).toBe('p/de3214f0.html');
    expect(previewImagePath({ setId: 'right-now', cardIds: ['a', 'b'], hand: 'TWO_PAIR' })).toBe('p/img/right-now/two-pair/a_b.jpg');
  });

  it('titles the preview', () => {
    expect(previewTitle('FOUR_OF_A_KIND', 'Summer of Slop')).toBe('A 4 of a Kind in Summer of Slop');
    expect(previewTitle('NO_MATCH', 'Summer of Slop')).toBe('A pack from Summer of Slop');
  });

  it('gives each modifier of a card its own page, apart from the plain one', () => {
    const paths = MODIFIER_TOKENS.map((token) => cardPreviewPath('right-now', 'jimothy', token));
    expect(new Set([...paths, cardPreviewPath('right-now', 'jimothy')]).size).toBe(MODIFIER_TOKENS.length + 1);
    for (const path of paths) expect(path).toMatch(/^p\/[0-9a-f]{8}\.html$/);
    expect(cardPreviewPath('right-now', 'jimothy', undefined)).toBe('p/9157df58.html');
  });
});

describe('modifier headline', () => {
  // Chance of each modifier per card, out of ODDS_TOTAL, from the engine's tables.
  const holoOdds = ALL_SET_VERSIONS.filter((set) => set.modifiers).map((set) => set.holoOdds);
  const odds = (token: ModifierToken): [number, number] =>
    token === 'HOLO' ? [Math.min(...holoOdds), Math.max(...holoOdds)] : token === 'MISPRINT' ? [MODIFIERS_V1.misprintOdds, MODIFIERS_V1.misprintOdds] : [MODIFIERS_V1.finishOdds[token], MODIFIERS_V1.finishOdds[token]];

  it('ranks modifiers by the engine odds, rarest first', () => {
    expect([...MODIFIER_TOKENS].sort()).toEqual([...FINISHES_RAREST_FIRST, 'HOLO', 'MISPRINT'].sort());
    expect(MODIFIER_TOKENS.filter((t) => t !== 'HOLO' && t !== 'MISPRINT')).toEqual(FINISHES_RAREST_FIRST);
    for (let i = 1; i < MODIFIER_TOKENS.length; i++) {
      const [rarer, commoner] = [MODIFIER_TOKENS[i - 1], MODIFIER_TOKENS[i]];
      // Strictly rarer, except Platinum and a misprint: equal odds, and the finish goes first.
      if (rarer === 'PLATINUM' && commoner === 'MISPRINT') expect(odds(rarer)[1]).toBe(odds(commoner)[0]);
      else expect(odds(rarer)[1], `${rarer} before ${commoner}`).toBeLessThan(odds(commoner)[0]);
    }
    expect(MODIFIER_TOKENS).toEqual(['DIAMOND', 'PLATINUM', 'MISPRINT', 'GOLD', 'HOLO', 'SILVER']);
    expect(PACK_HEADLINE_TOKENS).toEqual(MODIFIER_TOKENS.slice(0, MODIFIER_TOKENS.indexOf('GOLD') + 1));
  });

  it("lists a card's modifiers rarest first", () => {
    expect(modifierTokens({})).toEqual([]);
    expect(modifierTokens({ isHolo: true, finish: 'SILVER', misprint: true })).toEqual(['MISPRINT', 'HOLO', 'SILVER']);
    expect(modifierTokens({ isHolo: false, finish: 'PLATINUM', misprint: true })).toEqual(['PLATINUM', 'MISPRINT']);
    expect(modifierTokens({ finish: null, misprint: false, isHolo: true })).toEqual(['HOLO']);
  });

  it('picks the rarest modifier in a pack, first card on a tie', () => {
    expect(headline([])).toBeNull();
    expect(headline([{ isHolo: false }, { finish: null, misprint: false }])).toBeNull();
    expect(headline([{ isHolo: true }, { finish: 'SILVER' }, { finish: 'GOLD' }, { isHolo: true }])).toEqual({ token: 'GOLD', cardIndex: 2 });
    expect(headline([{ misprint: true }, { finish: 'PLATINUM' }])).toEqual({ token: 'PLATINUM', cardIndex: 1 });
    expect(headline([{ finish: 'GOLD' }, { misprint: true, isHolo: true }])).toEqual({ token: 'MISPRINT', cardIndex: 1 });
    expect(headline([{ finish: 'SILVER' }, { isHolo: true }])).toEqual({ token: 'HOLO', cardIndex: 1 });
    expect(headline([{ isHolo: true }, { finish: 'DIAMOND' }, { finish: 'DIAMOND', misprint: true }])).toEqual({ token: 'DIAMOND', cardIndex: 1 });
    expect(headline([{ finish: 'SILVER' }, { finish: 'SILVER' }])).toEqual({ token: 'SILVER', cardIndex: 0 });
  });

  it('has modifier pages only for sets that roll modifiers', () => {
    expect(hasModifierPages('genesis', ALL_SET_VERSIONS)).toBe(false);
    expect(hasModifierPages('web-ancients', ALL_SET_VERSIONS)).toBe(true); // v1 has none, v2 does
    expect(hasModifierPages('no-such-set', ALL_SET_VERSIONS)).toBe(false);
  });

  it('ensures Two Pair previewOf ordering matches handsOf for every set (#1315)', () => {
    for (const set of ALL_SET_VERSIONS) {
      const cardIds = [...new Set(set.cards.map((c) => c.id))];
      const ids = [...cardIds].sort(compareCardIds);
      // Code-unit Array#sort matches compareCardIds
      expect([...cardIds].sort()).toEqual(ids);

      // Verify for every pair in the set that Two Pair matches handsOf order [a, b]
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const a = ids[i];
          const b = ids[j];
          const c = ids.find((id) => id !== a && id !== b)!;
          const packCards = [
            { key: `${set.id}/${b}` },
            { key: `${set.id}/${b}` },
            { key: `${set.id}/${a}` },
            { key: `${set.id}/${a}` },
            { key: `${set.id}/${c}` },
          ];
          const preview = previewOf(packCards);
          expect(preview?.hand).toBe('TWO_PAIR');
          expect(preview?.cardIds).toEqual([a, b]);
        }
      }
    }
  });
});
