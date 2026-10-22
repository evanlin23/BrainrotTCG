import { describe, expect, it } from 'vitest';
import { isCardOwned, ownedCount, ownedVersions, sameVersion, versionOf } from './versions';
import type { HistoryEntry } from './history';

const entry = (cards: HistoryEntry['cards']): HistoryEntry => ({ setId: 'right-now', setVersion: 2, nonce: 0, key: 'ab', cards, hand: 'x', score: 0, openedAt: 0 });
const label = (list: ReturnType<typeof ownedVersions>) =>
  list.map(({ version: v, count }) => `${v.finish ?? ''}${v.isHolo ? '*' : ''}${v.misprint ? '!' : ''}x${count}`);

describe('owned versions', () => {
  it('keeps exact combinations from the history, most valuable first', () => {
    const history = [
      entry([{ id: 'jimothy', holo: true, finish: 'GOLD' }, { id: 'jimothy', holo: false }, { id: 'other', holo: false }]),
      entry([{ id: 'jimothy', holo: false, finish: 'SILVER', misprint: true }]),
    ];
    const item = { normalCount: 2, holoCount: 1, finishes: { GOLD: 1, SILVER: 1 }, misprints: 1 };
    expect(label(ownedVersions('right-now/jimothy', 'RARE', item, history))).toEqual(['SILVER!x1', 'GOLD*x1', 'x1']);
  });

  it("fills in copies the history doesn't cover from the collection's tallies", () => {
    const item = { normalCount: 3, holoCount: 1, finishes: { DIAMOND: 1 }, misprints: 1 };
    expect(label(ownedVersions('right-now/jimothy', 'COMMON', item, []))).toEqual(['DIAMONDx1', '!x1', '*x1', 'x1']);
  });

  it('never lists more than the collection holds', () => {
    const history = [entry([{ id: 'jimothy', holo: false, finish: 'GOLD' }, { id: 'jimothy', holo: false, finish: 'GOLD' }])];
    const item = { normalCount: 1, holoCount: 0, finishes: { GOLD: 1 } };
    expect(label(ownedVersions('right-now/jimothy', 'RARE', item, history))).toEqual(['GOLDx1']);
  });

  it('compares versions with defaults for missing fields', () => {
    expect(sameVersion(versionOf({ isHolo: true }), { isHolo: true, finish: null, misprint: false })).toBe(true);
    expect(sameVersion(versionOf({ finish: 'GOLD' }), versionOf({}))).toBe(false);
  });

  it('evaluates zero-copy and owned item records accurately', () => {
    expect(ownedCount(undefined)).toBe(0);
    expect(isCardOwned(undefined)).toBe(false);
    expect(ownedCount(null)).toBe(0);
    expect(isCardOwned(null)).toBe(false);
    expect(ownedCount({ normalCount: 0, holoCount: 0 })).toBe(0);
    expect(isCardOwned({ normalCount: 0, holoCount: 0 })).toBe(false);
    expect(ownedCount({ normalCount: 1, holoCount: 0 })).toBe(1);
    expect(isCardOwned({ normalCount: 1, holoCount: 0 })).toBe(true);
    expect(ownedCount({ normalCount: 0, holoCount: 2 })).toBe(2);
    expect(isCardOwned({ normalCount: 0, holoCount: 2 })).toBe(true);
    expect(ownedCount({ count: 3, normalCount: 0, holoCount: 0 })).toBe(3);
    expect(isCardOwned({ count: 3, normalCount: 0, holoCount: 0 })).toBe(true);
    expect(ownedCount({ count: 0, normalCount: 0, holoCount: 0 })).toBe(0);
    expect(isCardOwned({ count: 0, normalCount: 0, holoCount: 0 })).toBe(false);
  });
});
