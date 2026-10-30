import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from './history';
import { SETS } from '../content/sets';
import { newBestGain, newBestPack, packMedals, packRecord, recordBook } from './personalRecords';

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

const pack = (nonce: number, setId = 'genesis') => ({ setId, setVersion: 1, nonce, publicKeyHex: KEY });

/** Every order a history could be stored in gives the same answer: reversed and interleaved. */
const orders = <T,>(history: T[]): T[][] => [history, [...history].reverse(), [...history.filter((_, i) => i % 2), ...history.filter((_, i) => !(i % 2))]];

describe('packRecord (#1287, Spec 2 on #757)', () => {
  it('sets nothing on the first comparable pack', () => {
    expect(packRecord([], pack(0), 500)).toBeNull();
    expect(packRecord([entry(0, 0, { hand: '' })], pack(1), 500)).toBeNull();
  });

  it('is the all-time best when it strictly beats every earlier pack', () => {
    expect(packRecord([entry(0, 100, { setId: 'other-set' }), entry(1, 400)], pack(2), 900)).toEqual({ kind: 'best', score: 900, previous: 400 });
  });

  it('is a set best when it beats only the earlier packs of its own set', () => {
    const history = [entry(0, 1_000), entry(1, 200, { setId: 'other-set' })];
    expect(packRecord(history, pack(2, 'other-set'), 500)).toEqual({ kind: 'set-best', setId: 'other-set', score: 500, previous: 200 });
    // A tie with the set's best is no record (the earlier pack keeps it), and beating no earlier pack ranks nothing.
    expect(packRecord(history, pack(2, 'other-set'), 200)).toBeNull();
  });

  it("needs an earlier pack in the set for a set best: a set's first pack can only rank", () => {
    expect(packRecord([entry(0, 1_000), entry(1, 100)], pack(2, 'other-set'), 500)).toEqual({ kind: 'top', rank: 2 });
  });

  it('ranks only with at least 2 earlier packs, and only a pack that beats one of them (Strava)', () => {
    // One earlier pack: a lower pack is the worse of two, not "#2".
    expect(packRecord([entry(0, 1_000)], pack(1), 10)).toBeNull();
    expect(packRecord([entry(0, 1_000)], pack(1, 'other-set'), 500)).toBeNull();
    // Two earlier packs: the worst of three is no #3, but beating one of them is.
    expect(packRecord([entry(0, 1_000), entry(1, 500)], pack(2), 10)).toBeNull();
    expect(packRecord([entry(0, 1_000), entry(1, 500)], pack(2), 500)).toBeNull();
    expect(packRecord([entry(0, 1_000), entry(1, 500)], pack(2), 501)).toEqual({ kind: 'top', rank: 2 });
  });

  it('ranks #2 and #3 with ties keeping the earlier pack above, and nothing below #3', () => {
    const history = [entry(0, 300), entry(1, 200), entry(2, 100)];
    expect(packRecord(history, pack(3), 250)).toEqual({ kind: 'top', rank: 2 });
    expect(packRecord(history, pack(3), 300)).toEqual({ kind: 'top', rank: 2 });
    expect(packRecord(history, pack(3), 200)).toEqual({ kind: 'top', rank: 3 });
    expect(packRecord(history, pack(3), 150)).toEqual({ kind: 'top', rank: 3 });
    expect(packRecord(history, pack(3), 100)).toBeNull();
  });

  it("only counts this key's packs on earlier tickets, once each", () => {
    const history = [
      entry(0, 100),
      entry(1, 9_000, { key: OTHER.slice(0, 16) }),
      entry(5, 9_000),
      // Not admitted: the record of ticket 0 opened first is.
      entry(0, 8_000, { setId: 'z-set', openedAt: 9_999 }),
    ];
    expect(packRecord(history, pack(2), 500)).toEqual({ kind: 'best', score: 500, previous: 100 });
    expect(packRecord(history, { setId: 'genesis', setVersion: 1, nonce: 2 }, 500)).toBeNull();
  });

  it("is nothing for a pack whose ticket the profile admits another set's record of", () => {
    const history = [entry(0, 100), entry(1, 50, { setId: 'other-set', openedAt: 1 })];
    expect(packRecord(history, pack(1), 900)).toBeNull();
  });

  it('gives the same answer whatever order the history is stored in', () => {
    const history = [entry(0, 300), entry(1, 200, { setId: 'other-set' }), entry(2, 100)];
    for (const h of orders(history)) expect(packRecord(h, pack(3, 'other-set'), 250)).toEqual({ kind: 'set-best', setId: 'other-set', score: 250, previous: 200 });
  });
});

describe('packMedals (#1287)', () => {
  it('marks each pack that set an all-time or set best when it opened, and no other', () => {
    const first = entry(0, 500);
    const tie = entry(1, 500);
    const best = entry(2, 900);
    const setFirst = entry(3, 100, { setId: 'other-set' });
    const setBest = entry(4, 200, { setId: 'other-set' });
    const lower = entry(5, 150, { setId: 'other-set' });
    const standIn = entry(6, 0, { hand: '' });
    const theirs = entry(7, 9_999, { key: OTHER.slice(0, 16) });
    // Ticket 2 recorded again later in another set: only the record admitted (opened first) keeps the medal.
    const spare = entry(2, 9_000, { setId: 'z-set', openedAt: 99_999 });
    const history = [first, tie, best, setFirst, setBest, lower, standIn, theirs, spare];
    for (const h of orders(history)) {
      const medals = packMedals(h, KEY);
      expect([...medals]).toHaveLength(2);
      expect(medals.get(best)).toBe('best');
      expect(medals.get(setBest)).toBe('set-best');
    }
    expect(packMedals([], KEY).size).toBe(0);
  });
});

describe('recordBook (#1287)', () => {
  const set = SETS[0];
  const brainrot = set.cards.find((c) => c.rarity === 'BRAINROT')!.id;
  const common = set.cards.find((c) => c.rarity === 'COMMON')!.id;
  /** A pack of the real first set, with `holos` holo commons, or a Brainrot. */
  const opened = (nonce: number, { holos = 0, hasBrainrot = false, ...overrides }: Partial<HistoryEntry> & { holos?: number; hasBrainrot?: boolean } = {}) =>
    entry(nonce, 100, {
      setId: set.id,
      setVersion: set.version,
      cards: [
        ...Array.from({ length: holos }, () => ({ id: common, holo: true })),
        ...Array.from({ length: 5 - holos - (hasBrainrot ? 1 : 0) }, () => ({ id: common, holo: false })),
        ...(hasBrainrot ? [{ id: brainrot, holo: false }] : []),
      ],
      ...overrides,
    });
  const day = (d: number, hour = 12) => new Date(2026, 9, d, hour).getTime();

  it('is empty with no packs of this player', () => {
    for (const history of [[], [entry(0, 100, { key: OTHER.slice(0, 16) })], [entry(0, 0, { hand: '' })]]) {
      expect(recordBook(history, KEY)).toEqual({ bestPackBySet: [], mostHolos: null, mostPacksInADay: null, longestDroughtBroken: null });
    }
  });

  it('best pack per set: the first pack sets the bar, a tie keeps it, a strict beat sets the record', () => {
    const history = [
      entry(0, 500, { openedAt: 10 }),
      entry(1, 300, { setId: 'other-set', openedAt: 11 }),
      entry(2, 500, { openedAt: 12 }),
      entry(3, 400, { setId: 'other-set', openedAt: 13 }),
      entry(4, 400, { setId: 'other-set', openedAt: 14 }),
      entry(5, 9_000, { key: OTHER.slice(0, 16) }),
      entry(6, 0, { hand: '', openedAt: 16 }),
    ];
    for (const h of orders(history)) {
      expect(recordBook(h, KEY).bestPackBySet).toEqual([
        { setId: 'genesis', value: 500, previous: null, at: 10 },
        { setId: 'other-set', value: 400, previous: 300, at: 13 },
      ]);
    }
  });

  it('most holos: strict beats only, over packs whose cards can be read', () => {
    const history = [
      opened(0, { holos: 1, openedAt: 10 }),
      opened(1, { holos: 1, openedAt: 11 }),
      // Its cards aren't on this device, a set version this build doesn't know, another key.
      opened(2, { cards: null }),
      opened(3, { holos: 5, setVersion: 999 }),
      // A stand-in whose cards are saved here counts, as the drought counter counts it.
      opened(4, { holos: 2, hand: '', openedAt: 14 }),
      opened(5, { holos: 5, key: OTHER.slice(0, 16) }),
      opened(6, { holos: 2, openedAt: 16 }),
      opened(7, { holos: 2, openedAt: 17 }),
    ];
    for (const h of orders(history)) expect(recordBook(h, KEY).mostHolos).toEqual({ value: 2, previous: 1, at: 14 });
    expect(recordBook([opened(0, { holos: 3, openedAt: 10 }), opened(1, { openedAt: 11 })], KEY).mostHolos).toEqual({ value: 3, previous: null, at: 10 });
  });

  it('most packs in a day: by local calendar day, ties keep the earlier day, one per ticket', () => {
    const history = [
      entry(0, 1, { openedAt: day(1, 9) }),
      entry(1, 1, { openedAt: day(1, 23) }),
      entry(2, 1, { openedAt: day(2, 0) }),
      entry(3, 1, { openedAt: day(2, 1) }),
      // A second record of ticket 3 (another tab) counts once, and a stand-in or a bad time not at all.
      entry(3, 1, { setId: 'z-set', openedAt: day(2, 2) }),
      entry(4, 0, { hand: '', openedAt: day(2, 3) }),
      entry(5, 1, { openedAt: Number.NaN }),
      entry(6, 1, { openedAt: 0 }),
      entry(7, 1, { openedAt: day(3, 8) }),
      entry(8, 1, { openedAt: day(3, 9) }),
      entry(9, 1, { openedAt: day(3, 10) }),
      entry(10, 1, { openedAt: day(3, 11), key: OTHER.slice(0, 16) }),
    ];
    for (const h of orders(history)) expect(recordBook(h, KEY).mostPacksInADay).toEqual({ value: 3, previous: 2, at: day(3, 8) });
    expect(recordBook(history.slice(0, 7), KEY).mostPacksInADay).toEqual({ value: 2, previous: null, at: day(1, 9) });
  });

  it('longest drought broken: only droughts a Brainrot ended, every pack in them readable', () => {
    const at = (nonce: number) => 1_000 + nonce;
    const run = (from: number, misses: number) => Array.from({ length: misses }, (_, i) => opened(from + i));
    const history = [
      // 2 misses, then a Brainrot: the first drought sets the bar.
      ...run(0, 2),
      opened(2, { hasBrainrot: true }),
      // 2 again: a tie keeps the earlier one.
      ...run(3, 2),
      opened(5, { hasBrainrot: true }),
      // 4, but one pack's cards are unreadable: its length is unknown, so it doesn't count.
      ...run(6, 2),
      opened(8, { cards: null }),
      opened(9),
      opened(10, { hasBrainrot: true }),
      // 3: a strict beat sets the record.
      ...run(11, 3),
      opened(14, { hasBrainrot: true }),
      // Another key's Brainrot doesn't end this player's drought, and the drought still going isn't broken.
      opened(15, { hasBrainrot: true, key: OTHER.slice(0, 16) }),
      ...run(16, 9),
    ];
    for (const h of orders(history)) expect(recordBook(h, KEY).longestDroughtBroken).toEqual({ value: 3, previous: 2, at: at(14) });
    expect(recordBook(history.slice(0, 3), KEY).longestDroughtBroken).toEqual({ value: 2, previous: null, at: at(2) });
    expect(recordBook(run(0, 4), KEY).longestDroughtBroken).toBeNull();
  });
});
