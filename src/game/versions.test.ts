import { describe, expect, it } from 'vitest';
import { ownedVersions, sameVersion, versionOf } from './versions';
import type { HistoryEntry } from './history';

const entry = (cards: HistoryEntry['cards']): HistoryEntry => ({ setId: 'right-now', setVersion: 2, nonce: 0, key: 'ab', cards, hand: 'x', score: 0, openedAt: 0 });
const label = (list: ReturnType<typeof ownedVersions>) =>
  list.map(({ version: v, count }) => `${v.finish ?? ''}${v.isHolo ? '*' : ''}${v.misprint ? '!' : ''}${v.uncertain ? '?' : ''}x${count}`);

describe('owned versions', () => {
  it('keeps exact combinations from the history, most valuable first', () => {
    const history = [
      entry([{ id: 'jimothy', holo: true, finish: 'GOLD' }, { id: 'jimothy', holo: false }, { id: 'other', holo: false }]),
      entry([{ id: 'jimothy', holo: false, finish: 'SILVER', misprint: true }]),
    ];
    const item = { normalCount: 2, holoCount: 1, finishes: { GOLD: 1, SILVER: 1 }, misprints: 1 };
    expect(label(ownedVersions('right-now/jimothy', 'RARE', item, history))).toEqual(['SILVER!x1', 'GOLD*x1', 'x1']);
  });

  it("fills in copies the history doesn't cover from the collection's tallies, marking ambiguous combinations uncertain", () => {
    const item = { normalCount: 3, holoCount: 1, finishes: { DIAMOND: 1 }, misprints: 1 };
    expect(label(ownedVersions('right-now/jimothy', 'COMMON', item, []))).toEqual(['DIAMOND?x1', '!?x1', '*?x1', '?x1']);
  });

  it('never lists more than the collection holds', () => {
    const history = [entry([{ id: 'jimothy', holo: false, finish: 'GOLD' }, { id: 'jimothy', holo: false, finish: 'GOLD' }])];
    const item = { normalCount: 1, holoCount: 0, finishes: { GOLD: 1 } };
    expect(label(ownedVersions('right-now/jimothy', 'RARE', item, history))).toEqual(['GOLDx1']);
  });

  it('attributes uncached combined Gold Misprint as a single combined version, never two separate copies (issue #655)', () => {
    const item = { normalCount: 1, holoCount: 0, finishes: { GOLD: 1 }, misprints: 1 };
    // Before fix: produced GOLDx1 and !x1 (2 copies!). Under fix: produces GOLD!x1 (1 copy).
    const versions = ownedVersions('right-now/jimothy', 'RARE', item, []);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toEqual({ version: { isHolo: false, finish: 'GOLD', misprint: true }, count: 1 });
  });

  it('reconstructs duplicate combined variants when overlap is fully determined', () => {
    const item = { normalCount: 2, holoCount: 0, finishes: { GOLD: 2 }, misprints: 2 };
    const versions = ownedVersions('right-now/jimothy', 'RARE', item, []);
    expect(versions).toEqual([{ version: { isHolo: false, finish: 'GOLD', misprint: true }, count: 2 }]);
  });

  it('reconstructs holo combined variant when all copies are holo', () => {
    const item = { normalCount: 0, holoCount: 1, finishes: { GOLD: 1 }, misprints: 1 };
    const versions = ownedVersions('right-now/jimothy', 'RARE', item, []);
    expect(versions).toEqual([{ version: { isHolo: true, finish: 'GOLD', misprint: true }, count: 1 }]);
  });

  it('marks ambiguous modifiers as uncertain when overlap cannot be established without inventing combined variants', () => {
    const item = { normalCount: 2, holoCount: 0, finishes: { GOLD: 1 }, misprints: 1 };
    const versions = ownedVersions('right-now/jimothy', 'RARE', item, []);
    // Total selectable version counts equal aggregate ownership (2)
    expect(versions.reduce((sum, v) => sum + v.count, 0)).toBe(2);
    // Ambiguous modifiers are visibly uncertain
    expect(versions.every((v) => v.version.uncertain)).toBe(true);
    // Combined variant is not invented when overlap cannot be established
    expect(versions.some((v) => v.version.finish && v.version.misprint)).toBe(false);
  });

  it('returns exact combined version once exact history is available', () => {
    const history = [entry([{ id: 'jimothy', holo: false, finish: 'GOLD', misprint: true }])];
    const item = { normalCount: 1, holoCount: 0, finishes: { GOLD: 1 }, misprints: 1 };
    const versions = ownedVersions('right-now/jimothy', 'RARE', item, history);
    expect(versions).toEqual([{ version: { isHolo: false, finish: 'GOLD', misprint: true }, count: 1 }]);
  });

  it('handles partially cached history with combined and plain copies without exceeding ownership', () => {
    const history = [entry([{ id: 'jimothy', holo: false, finish: 'GOLD', misprint: true }])];
    const item = { normalCount: 2, holoCount: 0, finishes: { GOLD: 1 }, misprints: 1 };
    const versions = ownedVersions('right-now/jimothy', 'RARE', item, history);
    expect(versions).toEqual([
      { version: { isHolo: false, finish: 'GOLD', misprint: true }, count: 1 },
      { version: { isHolo: false, finish: null, misprint: false }, count: 1 },
    ]);
  });

  it('compares versions with defaults for missing fields', () => {
    expect(sameVersion(versionOf({ isHolo: true }), { isHolo: true, finish: null, misprint: false })).toBe(true);
    expect(sameVersion(versionOf({ finish: 'GOLD' }), versionOf({}))).toBe(false);
  });
});
