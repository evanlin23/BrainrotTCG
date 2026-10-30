import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from './history';
import { newBestGain, newBestPack } from './personalRecords';

const KEY = '0123456789abcdef0000111122223333';
const OTHER = 'fedcba98765432100000111122223333';

const entry = (nonce: number, score: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
  setId: 'genesis',
  setVersion: 1,
  nonce,
  key: KEY.slice(0, 16),
  cards: null,
  hand: 'Pair',
  score,
  openedAt: 1_000 + nonce,
  ...overrides,
});

describe('newBestPack (#1287)', () => {
  it('sets no record on the first comparable pack, even though it is recorded already', () => {
    expect(newBestPack([entry(0, 500)], { setId: 'genesis', setVersion: 1, nonce: 0, publicKeyHex: KEY }, 500)).toBeNull();
    expect(newBestPack([], { setId: 'genesis', setVersion: 1, nonce: 0, publicKeyHex: KEY }, 500)).toBeNull();
  });

  it('is a NEW BEST when the pack strictly beats the best before it', () => {
    const history = [entry(2, 9_800_000), entry(1, 1_000), entry(0, 4_515_000)];
    expect(newBestPack(history, { setId: 'genesis', setVersion: 1, nonce: 2, publicKeyHex: KEY }, 9_800_000)).toEqual({ score: 9_800_000, previous: 4_515_000 });
  });

  it('is no record on a tie or below', () => {
    const history = [entry(1, 4_515_000), entry(0, 4_515_000)];
    expect(newBestPack(history, { setId: 'genesis', setVersion: 1, nonce: 1, publicKeyHex: KEY }, 4_515_000)).toBeNull();
    expect(newBestPack(history, { setId: 'genesis', setVersion: 1, nonce: 1, publicKeyHex: KEY }, 1_000)).toBeNull();
  });

  it("the pack after a new best doesn't repeat it (the fixture's next 1,000-point pack)", () => {
    const history = [entry(3, 1_000), entry(2, 9_800_000), entry(0, 4_515_000)];
    expect(newBestPack(history, { setId: 'genesis', setVersion: 1, nonce: 3, publicKeyHex: KEY }, 1_000)).toBeNull();
  });

  it('compares across every set: the all-time best, not a per-set one', () => {
    const history = [entry(1, 600, { setId: 'other-set' }), entry(0, 800)];
    expect(newBestPack(history, { setId: 'genesis', setVersion: 1, nonce: 1, publicKeyHex: KEY }, 600)).toBeNull();
    expect(newBestPack(history, { setId: 'genesis', setVersion: 1, nonce: 2, publicKeyHex: KEY }, 900)).toEqual({ score: 900, previous: 800 });
  });

  it("compares only this player's packs, never another identity's", () => {
    const history = [entry(1, 900), entry(0, 5_000, { key: OTHER.slice(0, 16) }), entry(0, 100)];
    expect(newBestPack(history, { setId: 'genesis', setVersion: 1, nonce: 1, publicKeyHex: KEY }, 900)).toEqual({ score: 900, previous: 100 });
    // The other player's best is their own 5,000, whatever this player scored.
    expect(newBestPack(history, { setId: 'genesis', setVersion: 1, nonce: 1, publicKeyHex: OTHER }, 4_000)).toBeNull();
    expect(newBestPack(history, { setId: 'genesis', setVersion: 1, nonce: 1, publicKeyHex: OTHER }, 9_000)).toEqual({ score: 9_000, previous: 5_000 });
    // A pack with no key (an older ref) has no player to compare against.
    expect(newBestPack(history, { setId: 'genesis', setVersion: 1, nonce: 1 }, 900)).toBeNull();
  });

  it('only counts packs on earlier tickets', () => {
    // Ticket 5 was spent in another tab: it isn't "before" the pack on ticket 3.
    const history = [entry(5, 10_000), entry(3, 900), entry(0, 100)];
    expect(newBestPack(history, { setId: 'genesis', setVersion: 1, nonce: 3, publicKeyHex: KEY }, 900)).toEqual({ score: 900, previous: 100 });
  });

  it('skips ticket stand-ins, whose hand and score are not known yet', () => {
    const history = [entry(1, 900), entry(0, 0, { hand: '' })];
    expect(newBestPack(history, { setId: 'genesis', setVersion: 1, nonce: 1, publicKeyHex: KEY }, 900)).toBeNull();
  });

  it('counts a ticket recorded twice once, as the record a profile admits (opened first)', () => {
    const history = [
      entry(2, 900),
      // A later conflicting record of ticket 0 scores higher, but the one opened first is admitted.
      entry(0, 5_000, { setId: 'z-set', openedAt: 3_000 }),
      entry(0, 100, { openedAt: 1_000 }),
    ];
    expect(newBestPack(history, { setId: 'genesis', setVersion: 1, nonce: 2, publicKeyHex: KEY }, 900)).toEqual({ score: 900, previous: 100 });
  });
});

describe('newBestPack on a ticket spent twice (#1287)', () => {
  const history = [
    entry(2, 900, { openedAt: 2_000 }),
    entry(2, 50, { setId: 'other-set', openedAt: 1_500 }),
    entry(0, 100),
  ];

  it('is no record for a pack whose ticket the profile admits another record of (opened first)', () => {
    expect(newBestPack(history, { setId: 'genesis', setVersion: 1, nonce: 2, publicKeyHex: KEY }, 900)).toBeNull();
  });

  it('is a record for the admitted one, if it beats the best before it', () => {
    expect(newBestPack(history, { setId: 'other-set', setVersion: 1, nonce: 2, publicKeyHex: KEY }, 500)).toEqual({ score: 500, previous: 100 });
  });

  it('still compares a pack whose own record the history lacks (its write failed)', () => {
    expect(newBestPack([entry(0, 100)], { setId: 'genesis', setVersion: 1, nonce: 2, publicKeyHex: KEY }, 900)).toEqual({ score: 900, previous: 100 });
  });
});

describe('newBestGain', () => {
  it('gives the rise over the previous best, rounded', () => {
    expect(newBestGain({ score: 9_800_000, previous: 4_515_000 })).toBe('+117%');
  });

  it('gives nothing below 1% or with no previous score to divide by', () => {
    expect(newBestGain({ score: 1_001, previous: 1_000 })).toBeNull();
    expect(newBestGain({ score: 10, previous: 0 })).toBeNull();
  });
});
