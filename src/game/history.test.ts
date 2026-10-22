import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { byBest, findPackByCards, findPackWithCard, firstOpened, getHistory, historyForKey, isHallOfFameWorthy, migratePullLog, recordMissing, recordPack, recordTicket, type HistoryEntry } from './history';
import { HALL_OF_FAME_MIN_SCORE, scorePulled } from '../engine';
import { getSet } from '../content/sets';
import { decodeCard, toPulled } from './cardCode';
import { putStoredPacks, resetPackStore } from './packStore';
import type { OpenedPack } from './pulls';

/** Minimal localStorage with an optional size cap, to exercise the out-of-space path. */
const installStorage = (maxChars = Infinity) => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > maxChars) throw new DOMException('full', 'QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k: string) => data.delete(k),
  });
  return data;
};

const KEY = 'ab'.repeat(32);

const pack = (nonce: number, overrides: Partial<OpenedPack> = {}) =>
  ({
    setId: 'right-now',
    setVersion: 1,
    nonce,
    publicKeyHex: KEY,
    cards: ['bombardiro-crocodilo', 'tung-tung-sahur', 'ballerina-cappuccina', 'chimpanzini-bananini', 'lirili-larila'].map(
      (id, i) => ({ id, isHolo: i === 1 }),
    ),
    score: { hand: { name: 'Pair' }, score: 100 },
    openedAt: 1_000 + nonce,
    ...overrides,
  }) as unknown as OpenedPack;

describe('pack history', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('records packs newest first and round-trips cards and holo flags', () => {
    installStorage();
    recordPack(pack(0));
    recordPack(pack(1));
    const history = getHistory();
    expect(history.map((e) => e.nonce)).toEqual([1, 0]);
    expect(history[0]).toMatchObject({
      setId: 'right-now',
      setVersion: 1,
      key: KEY.slice(0, 16),
      hand: 'Pair',
      score: 100,
    });
    expect(history[0].cards?.slice(0, 2)).toEqual([
      { id: 'bombardiro-crocodilo', holo: false },
      { id: 'tung-tung-sahur', holo: true },
    ]);
  });

  it('keeps one entry per ticket', () => {
    installStorage();
    recordPack(pack(3));
    recordPack(pack(3, { openedAt: 9_999 }));
    expect(getHistory()).toHaveLength(1);
    expect(getHistory()[0].openedAt).toBe(9_999);
  });

  it('keeps both records when another set is recorded on the same ticket, rather than the last one winning', () => {
    installStorage();
    recordPack(pack(3));
    recordPack(pack(3, { setId: 'genesis', openedAt: 2_000 }));
    expect(getHistory().map((e) => [e.setId, e.nonce, e.openedAt])).toEqual([['genesis', 3, 2_000], ['right-now', 3, 1_003]]);
    // Re-recording one of them still replaces only that one.
    recordPack(pack(3, { openedAt: 9_999 }));
    expect(getHistory().map((e) => [e.setId, e.openedAt])).toEqual([['right-now', 9_999], ['genesis', 2_000]]);
  });

  it('lists one key in ticket order', () => {
    installStorage();
    recordPack(pack(2));
    recordPack(pack(0));
    recordPack(pack(1, { publicKeyHex: 'cd'.repeat(32) }));
    expect(historyForKey(KEY).map((e) => e.nonce)).toEqual([0, 2]);
  });

  it('drops cached cards of older packs when storage is full, but keeps every ticket', () => {
    const data = installStorage();
    for (let n = 0; n < 6; n++) recordPack(pack(n));
    const full = data.get(STORAGE_KEYS.HISTORY)!.length;
    installStorage(full); // now exactly at the limit: the next write overflows
    localStorage.setItem(STORAGE_KEYS.HISTORY, data.get(STORAGE_KEYS.HISTORY)!);
    recordPack(pack(6));
    const history = getHistory();
    expect(history.map((e) => e.nonce)).toEqual([6, 5, 4, 3, 2, 1, 0]);
    expect(history[0].cards).not.toBeNull();
    expect(history[history.length - 1].cards).toBeNull();
  });

  it('carries the old notable-pulls log over once, without cards', () => {
    installStorage();
    recordPack(pack(1));
    localStorage.setItem(
      STORAGE_KEYS.PULLS,
      JSON.stringify([
        { setId: 'right-now', setVersion: 1, nonce: 1, publicKeyHex: KEY, score: 100, hand: 'Pair', openedAt: 1001 },
        { setId: 'right-now', setVersion: 1, nonce: 0, publicKeyHex: KEY, score: 50, hand: 'No Matches', openedAt: 1000 },
        { setId: 'genesis', setVersion: 1, nonce: 5, score: 1, hand: 'x', openedAt: 1 },
      ]),
    );
    migratePullLog();
    const history = getHistory();
    expect(history.map((e) => e.nonce)).toEqual([1, 0]);
    expect(history[0].cards).not.toBeNull();
    expect(history[1].cards).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.PULLS)).toBeNull();
  });
});

describe('recording the ticket mappings a full storage refused', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds only the missing ones, newest first, and leaves recorded ones as they are', () => {
    installStorage();
    recordPack(pack(0));
    recordPack(pack(2, { openedAt: 5_000 }));
    expect(recordMissing([pack(1), pack(2), pack(3, { openedAt: 9_000 })], KEY)).toBe(true);
    expect(getHistory().map((e) => [e.nonce, e.openedAt])).toEqual([[3, 9_000], [2, 5_000], [1, 1_001], [0, 1_000]]);
    expect(getHistory().find((e) => e.nonce === 1)?.cards).toHaveLength(5);
  });

  it("never adds another player's packs, or a pack without a key", () => {
    installStorage();
    expect(recordMissing([pack(0, { publicKeyHex: 'cd'.repeat(32) }), pack(1, { publicKeyHex: undefined })], KEY)).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.HISTORY)).toBeNull();
  });

  it('keeps both mappings when a ticket was already recorded under another set, changing neither', () => {
    installStorage();
    recordPack(pack(1));
    const [original] = getHistory();
    expect(recordMissing([pack(1, { setId: 'other-set', openedAt: 2_000 })], KEY)).toBe(true);
    const history = getHistory();
    expect(history.map((e) => [e.setId, e.nonce])).toEqual([['other-set', 1], ['right-now', 1]]);
    expect(history[1]).toEqual(original);
    expect(recordMissing([pack(1, { setId: 'other-set', openedAt: 2_000 })], KEY)).toBe(true);
    expect(getHistory()).toHaveLength(2);
  });

  it("puts a pack in its ticket's stand-in, and never in place of another set's record", () => {
    installStorage();
    expect(recordTicket('right-now', 1, 1, KEY, 500)).toBe(true);
    expect(recordTicket('other-set', 1, 2, KEY, 600)).toBe(true);
    recordPack(pack(2, { setId: 'other-set', openedAt: 700 }));
    expect(recordMissing([pack(1), pack(2)], KEY)).toBe(true);
    const history = getHistory();
    // Each stand-in is filled where it was, keeping its time; the pack with no stand-in goes in by time.
    expect(history.map((e) => [e.setId, e.nonce, e.hand, e.openedAt])).toEqual([['right-now', 2, 'Pair', 1_002], ['other-set', 2, 'Pair', 600], ['right-now', 1, 'Pair', 500]]);
    expect(history[2].cards).toHaveLength(5);
  });

  it('writes nothing when nothing is missing', () => {
    const data = installStorage();
    recordPack(pack(0));
    const stored = data.get(STORAGE_KEYS.HISTORY);
    const setItem = vi.spyOn(localStorage, 'setItem');
    expect(recordMissing([pack(0)], KEY)).toBe(true);
    expect(setItem).not.toHaveBeenCalled();
    expect(data.get(STORAGE_KEYS.HISTORY)).toBe(stored);
  });

  it('reports a history it could not write, or one it would have to drop entries from', () => {
    installStorage(10);
    expect(recordMissing([pack(0)], KEY)).toBe(false);
    const data = installStorage();
    data.set(STORAGE_KEYS.HISTORY, '[null]');
    expect(recordMissing([pack(0)], KEY)).toBe(false);
    expect(data.get(STORAGE_KEYS.HISTORY)).toBe('[null]');
  });
});

describe('recording a ticket before its pack is in hand', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps the ticket to its set with no cards or hand, once, until the pack replaces it', () => {
    installStorage();
    expect(recordTicket('right-now', 1, 4, KEY, 1_004)).toBe(true);
    expect(recordTicket('right-now', 1, 4, KEY, 2_000)).toBe(true);
    expect(historyForKey(KEY).map((e) => [e.setId, e.setVersion, e.nonce, e.cards, e.hand, e.score, e.openedAt])).toEqual([['right-now', 1, 4, null, '', 0, 1_004]]);
    recordPack(pack(4));
    expect(historyForKey(KEY)).toHaveLength(1);
    expect(historyForKey(KEY)[0]).toMatchObject({ hand: 'Pair', score: 100 });
    // A recorded pack is never replaced by a stand-in.
    expect(recordTicket('right-now', 1, 4, KEY, 3_000)).toBe(true);
    expect(historyForKey(KEY)[0].cards).toHaveLength(5);
  });

  it('fills the stand-in where it is, keeping its time, so the history does not reorder when the pack opens', () => {
    installStorage();
    expect(recordTicket('right-now', 1, 1, KEY, 500)).toBe(true);
    recordPack(pack(2, { openedAt: 600 }));
    recordPack(pack(1, { openedAt: 700 }));
    const history = getHistory();
    expect(history.map((e) => [e.nonce, e.hand, e.openedAt])).toEqual([[2, 'Pair', 600], [1, 'Pair', 500]]);
    expect(history[1].cards).toHaveLength(5);
    // A recorded pack recorded again still moves to the front, as before.
    recordPack(pack(1, { openedAt: 800 }));
    expect(getHistory().map((e) => [e.nonce, e.openedAt])).toEqual([[1, 800], [2, 600]]);
  });

  it.each([
    ['recordPack', () => recordPack(pack(5, { openedAt: 3_000 }))],
    ['recordMissing', () => recordMissing([pack(5, { openedAt: 3_000 })], KEY)],
  ])('%s fills a stand-in held beside a full entry for the same assignment, leaving one, and keeps a conflicting one', (_, fill) => {
    const data = installStorage();
    recordPack(pack(5));
    // Another set on the same ticket: a conflicting assignment, which stays.
    recordPack(pack(5, { setId: 'genesis', openedAt: 2_000 }));
    // A stand-in for the first assignment beside its full entry (an imported backup can carry both).
    const stored = JSON.parse(data.get(STORAGE_KEYS.HISTORY)!) as { k: string }[];
    const standIn = { s: 'right-now', v: 1, n: 5, k: stored[0].k, h: '', x: 0, t: 1_200 };
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify([...stored, standIn]));
    // Listed once even before the fill, as the fill will store it: the pack, at the stand-in's time.
    expect(getHistory().filter((e) => e.setId === 'right-now').map((e) => [e.openedAt, e.cards?.length])).toEqual([[1_200, 5]]);

    expect(fill()).toBe(true);
    const history = getHistory();
    expect(history.map((e) => [e.setId, e.nonce, e.hand, e.openedAt])).toEqual([['genesis', 5, 'Pair', 2_000], ['right-now', 5, 'Pair', 1_200]]);
    expect(history[1].cards).toHaveLength(5);
  });

  it('lists a stand-in stored beside its own full entry once, without writing, and keeps every other stand-in', () => {
    const data = installStorage();
    recordPack(pack(5));
    expect(recordTicket('right-now', 1, 6, KEY, 1_600)).toBe(true);
    const stored = JSON.parse(data.get(STORAGE_KEYS.HISTORY)!) as { k: string }[];
    const standIn = (s: string, n: number) => ({ s, v: 1, n, k: stored[0].k, h: '', x: 0, t: 1_200 });
    // Beside its own pack's entry (an imported backup or an older build kept both), and beside it
    // for another set on the same ticket, which is a different assignment.
    const raw = JSON.stringify([...stored, standIn('right-now', 5), standIn('genesis', 5)]);
    data.set(STORAGE_KEYS.HISTORY, raw);
    expect(getHistory().map((e) => [e.setId, e.nonce, e.cards?.length ?? null])).toEqual([['right-now', 6, null], ['right-now', 5, 5], ['genesis', 5, null]]);
    expect(historyForKey(KEY).map((e) => [e.setId, e.nonce])).toEqual([['right-now', 5], ['genesis', 5], ['right-now', 6]]);
    expect(data.get(STORAGE_KEYS.HISTORY)).toBe(raw);
  });

  it('lists a stand-in beside its full entry at the stand-in\'s time, so a profile admits the same set on a conflicting ticket before and after the fill', () => {
    const data = installStorage();
    recordPack(pack(5, { setId: 'genesis', openedAt: 2_000 }));
    recordPack(pack(5, { openedAt: 3_000 }));
    const stored = JSON.parse(data.get(STORAGE_KEYS.HISTORY)!) as { k: string }[];
    // The ticket was claimed for right-now at 1200, before genesis took the same nonce.
    const raw = JSON.stringify([...stored, { s: 'right-now', v: 1, n: 5, k: stored[0].k, h: '', x: 0, t: 1_200 }]);
    data.set(STORAGE_KEYS.HISTORY, raw);
    // The rule a profile admits one assignment per ticket by (profiles.ts ticketsOf).
    const admitted = () => historyForKey(KEY).reduce((a, b) => (firstOpened(b, a) < 0 ? b : a));
    const listed = () => getHistory().map((e) => [e.setId, e.openedAt, e.cards?.length ?? null]);
    const before = listed();
    expect(before).toEqual([['genesis', 2_000, 5], ['right-now', 1_200, 5]]);
    expect(admitted()).toMatchObject({ setId: 'right-now', openedAt: 1_200 });
    expect(data.get(STORAGE_KEYS.HISTORY)).toBe(raw);

    expect(recordPack(pack(5, { openedAt: 3_000 }))).toBe(true);
    expect(listed()).toEqual(before);
    expect(admitted()).toMatchObject({ setId: 'right-now', openedAt: 1_200 });
  });

  it('lists a pack stored as several stand-ins and full entries once, in its first stand-in\'s place, as the fill will store it', () => {
    const data = installStorage();
    recordPack(pack(5, { openedAt: 3_000 }));
    const [full] = JSON.parse(data.get(STORAGE_KEYS.HISTORY)!) as { k: string }[];
    const standIn = (n: number, t: number) => ({ s: 'right-now', v: 1, n, k: full.k, h: '', x: 0, t });
    // Pack 5 as two full entries (the older one without its cards, as a full store leaves it) and two
    // stand-ins; pack 6 as two stand-ins with no full entry. Imported backups or older builds can leave either.
    const raw = JSON.stringify([
      standIn(6, 2_800), full, standIn(5, 1_500), { ...full, c: undefined, t: 1_400 }, standIn(6, 1_300), standIn(5, 1_200),
    ]);
    data.set(STORAGE_KEYS.HISTORY, raw);
    const listed = () => getHistory().map((e) => [e.nonce, e.openedAt]);
    expect(listed()).toEqual([[6, 2_800], [5, 1_500]]);
    // Filled from the first full entry stored, which still has its cards.
    expect(getHistory().map((e) => e.cards?.length ?? null)).toEqual([null, 5]);
    expect(data.get(STORAGE_KEYS.HISTORY)).toBe(raw);

    expect(recordPack(pack(5, { openedAt: 4_000 }))).toBe(true);
    expect(recordPack(pack(6, { openedAt: 4_000 }))).toBe(true);
    expect(listed()).toEqual([[6, 2_800], [5, 1_500]]);
    expect(JSON.parse(data.get(STORAGE_KEYS.HISTORY)!)).toHaveLength(2);
  });

  it('reports a history it could not read or write', () => {
    installStorage(10);
    expect(recordTicket('right-now', 1, 0, KEY, 1)).toBe(false);
    const data = installStorage();
    data.set(STORAGE_KEYS.HISTORY, '[null]');
    expect(recordTicket('right-now', 1, 0, KEY, 1)).toBe(false);
    expect(data.get(STORAGE_KEYS.HISTORY)).toBe('[null]');
  });
});

describe('a stand-in whose pack this device re-opened', () => {
  // A Full House: worth the Hall of Fame, and far above the Pair the other packs here score.
  const CODE = 'jimothy*,jimothy,jimothy,verity,verity';
  const expected = () => scorePulled(toPulled(CODE.split(',').map(decodeCard), getSet('right-now', 1)!)!);

  beforeEach(() => {
    vi.unstubAllGlobals();
    resetPackStore();
  });

  it('reads with the hand and score of its cards, so Best and the Hall of Fame count it, and writes nothing', async () => {
    const data = installStorage();
    expect(recordTicket('right-now', 1, 7, KEY, 900)).toBe(true);
    recordPack(pack(8, { openedAt: 1_000 }));
    const stored = data.get(STORAGE_KEYS.HISTORY);
    expect(historyForKey(KEY).find((e) => e.nonce === 7)).toMatchObject({ cards: null, hand: '', score: 0 });
    await putStoredPacks([{ setKey: 'right-now@1', publicKeyHex: KEY, nonce: 7, cards: CODE }]);
    const { hand, score } = expected();
    expect(hand.name).toBe('Full House');
    const filled = historyForKey(KEY).find((e) => e.nonce === 7)!;
    expect(filled).toMatchObject({ hand: 'Full House', score, openedAt: 900 });
    expect(filled.cards).toHaveLength(5);
    expect(isHallOfFameWorthy(filled)).toBe(true);
    expect([...getHistory()].sort(byBest).map((e) => e.nonce)).toEqual([7, 8]);
    // Worked out on read: the stand-in is stored as it was, and still gives way to its pack.
    expect(data.get(STORAGE_KEYS.HISTORY)).toBe(stored);
    recordPack(pack(7, { openedAt: 1_100 }));
    expect(historyForKey(KEY).map((e) => [e.nonce, e.hand, e.score, e.openedAt])).toEqual([[7, 'Pair', 100, 900], [8, 'Pair', 100, 1_000]]);
  });

  it("never scores a stand-in from cards its set version doesn't have, or another key's pack", async () => {
    installStorage();
    expect(recordTicket('right-now', 1, 7, KEY, 900)).toBe(true);
    await putStoredPacks([
      { setKey: 'right-now@1', publicKeyHex: KEY, nonce: 7, cards: 'jimothy,jimothy,jimothy,verity,not-a-card' },
      { setKey: 'right-now@1', publicKeyHex: 'cd'.repeat(32), nonce: 7, cards: CODE },
    ]);
    expect(historyForKey(KEY)[0]).toMatchObject({ hand: '', score: 0 });
  });

  it('decodes the history once for every read of one pack open, and again only when it or the re-opened packs change', async () => {
    const data = installStorage();
    expect(recordTicket('right-now', 1, 7, KEY, 900)).toBe(true);
    recordPack(pack(8, { openedAt: 1_000 }));
    const parse = vi.spyOn(JSON, 'parse');
    // Each decode parses the stored history; nothing else here does.
    const decodes = () => parse.mock.calls.filter(([text]) => text === data.get(STORAGE_KEYS.HISTORY)).length;
    const readAll = () => {
      historyForKey(KEY);
      findPackWithCard(KEY, 'right-now', 'tung-tung-sahur');
      findPackByCards([], 'right-now', 1_000);
      return getHistory();
    };
    try {
      const first = getHistory();
      expect(readAll()).toBe(first);
      expect(decodes()).toBe(1);

      // The stand-in's pack re-opened on this device: decoded again, with its cards.
      await putStoredPacks([{ setKey: 'right-now@1', publicKeyHex: KEY, nonce: 7, cards: CODE }]);
      const reopened = readAll();
      expect(reopened).not.toBe(first);
      expect(reopened.find((e) => e.nonce === 7)?.cards).toHaveLength(5);
      expect(decodes()).toBe(2);

      // Another write (here or in another tab) changes the stored history: decoded again.
      parse.mockClear();
      recordPack(pack(9, { openedAt: 1_100 }));
      parse.mockClear();
      expect(readAll().map((e) => e.nonce)).toEqual([9, 8, 7]);
      expect(readAll()).toBe(getHistory());
      expect(decodes()).toBe(1);
    } finally {
      parse.mockRestore();
    }
  });
});

describe('a long pack history in full storage', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps every ticket and the collection when a save overflows, and loses nothing when even that fails', () => {
    // One quota shared by every key, as a browser's storage has.
    const data = new Map<string, string>();
    let quota = Infinity;
    const used = (except?: string) => [...data].reduce((sum, [k, v]) => (k === except ? sum : sum + k.length + v.length), 0);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (used(k) + k.length + v.length > quota) throw new DOMException('full', 'QuotaExceededError');
        data.set(k, v);
      },
      removeItem: (k: string) => data.delete(k),
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const LONG = 3_000;
    const collection = JSON.stringify({ 'right-now/tung-tung-sahur': { normalCount: 40, holoCount: 2 } });
    data.set(STORAGE_KEYS.COLLECTION, collection);
    expect(recordMissing(Array.from({ length: LONG }, (_, n) => pack(n)), KEY)).toBe(true);
    const nonces = (count: number) => Array.from({ length: count }, (_, n) => count - 1 - n);

    // Full: the next pack still saves, by dropping older packs' cached cards, never a ticket.
    quota = used();
    expect(recordPack(pack(LONG))).toBe(true);
    let history = getHistory();
    expect(history.map((e) => e.nonce)).toEqual(nonces(LONG + 1));
    expect(history[0].cards).toHaveLength(5);
    expect(history[LONG].cards).toBeNull();
    expect(data.get(STORAGE_KEYS.COLLECTION)).toBe(collection);

    // So full that even the bare log can't grow: the save is refused and reported, and the stored log
    // and collection stay exactly as they were.
    const log = data.get(STORAGE_KEYS.HISTORY)!;
    const bare = JSON.stringify((JSON.parse(log) as { c?: string }[]).map(({ c: _cards, ...rest }) => rest));
    quota = used() - log.length + bare.length;
    expect(recordPack(pack(LONG + 1))).toBe(false);
    expect(error).toHaveBeenCalledWith('Could not save pack history');
    expect(data.get(STORAGE_KEYS.HISTORY)).toBe(log);
    expect(data.get(STORAGE_KEYS.COLLECTION)).toBe(collection);

    // Once there is room, the refused pack's mapping is added back and nothing is missing.
    quota = Infinity;
    expect(recordMissing([pack(LONG + 1)], KEY)).toBe(true);
    history = getHistory();
    expect(history.map((e) => e.nonce)).toEqual(nonces(LONG + 2));
    expect(data.get(STORAGE_KEYS.COLLECTION)).toBe(collection);
  });
});

describe('sorting and filtering packs', () => {
  const entry = (hand: string, score: number, openedAt: number): HistoryEntry => ({ setId: 'right-now', setVersion: 1, nonce: openedAt, key: 'ab', cards: null, hand, score, openedAt });

  it('marks what the Hall of Fame would take', () => {
    expect(isHallOfFameWorthy(entry('Full House', 900, 1))).toBe(true);
    expect(isHallOfFameWorthy(entry('5 of a Kind', 10, 1))).toBe(true);
    expect(isHallOfFameWorthy(entry('3 of a Kind', 900, 1))).toBe(false);
    expect(isHallOfFameWorthy(entry('Pair', HALL_OF_FAME_MIN_SCORE, 1))).toBe(true); // a big enough score on its own
    expect(isHallOfFameWorthy(entry('No Matches', HALL_OF_FAME_MIN_SCORE - 1, 1))).toBe(false);
  });

  it('puts the best first, newest first among equals', () => {
    const sorted = [entry('Pair', 50, 1), entry('Pair', 900, 2), entry('Pair', 50, 3)].sort(byBest);
    expect(sorted.map((e) => e.openedAt)).toEqual([2, 3, 1]);
  });
});

describe('finding a pack by its cards', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  const cardsOf = (p: OpenedPack) => p.cards.map((c) => ({ id: c.id, holo: c.isHolo }));

  it('finds the same five cards opened nearest the time, and nothing for other cards or long after', () => {
    installStorage();
    const hour = 3600_000;
    recordPack(pack(0, { openedAt: 10 * hour }));
    recordPack(pack(1, { openedAt: 12 * hour }));
    expect(findPackByCards(cardsOf(pack(0)), 'right-now', 10 * hour + 5_000)?.nonce).toBe(0);
    expect(findPackByCards(cardsOf(pack(0)), 'right-now', 12 * hour - 5_000)?.nonce).toBe(1);
    expect(findPackByCards(cardsOf(pack(0)), 'right-now', 30 * hour)).toBeNull();
    expect(findPackByCards(cardsOf(pack(0)), 'genesis', 10 * hour)).toBeNull();
    const holoSwapped = cardsOf(pack(0)).map((c) => ({ ...c, holo: !c.holo }));
    expect(findPackByCards(holoSwapped, 'right-now', 10 * hour)).toBeNull();
  });
});

describe('finding a pack with a card', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    installStorage();
  });

  it('falls back to same-holo or any copy when exactOnly is false or omitted', () => {
    // Ticket 1 has plain tung-tung-sahur
    recordPack(pack(1, {
      cards: [{ id: 'tung-tung-sahur', isHolo: false, finish: null, misprint: false }] as unknown as OpenedPack['cards'],
    }));

    // Looking for Silver tung-tung-sahur without exactOnly falls back to same-holo (isHolo: false)
    const found = findPackWithCard(KEY, 'right-now', 'tung-tung-sahur', { isHolo: false, finish: 'SILVER', misprint: false });
    expect(found?.nonce).toBe(1);

    // Looking for Holo tung-tung-sahur without exactOnly falls back to any copy
    const foundAny = findPackWithCard(KEY, 'right-now', 'tung-tung-sahur', { isHolo: true, finish: null, misprint: false });
    expect(foundAny?.nonce).toBe(1);
  });

  it('returns null when exactOnly is true and exact variant is missing from cache', () => {
    // Ticket 1 has plain tung-tung-sahur (not Silver)
    recordPack(pack(1, {
      cards: [{ id: 'tung-tung-sahur', isHolo: false, finish: null, misprint: false }] as unknown as OpenedPack['cards'],
    }));

    // Looking for Silver with exactOnly: true strictly returns null
    const found = findPackWithCard(KEY, 'right-now', 'tung-tung-sahur', { isHolo: false, finish: 'SILVER', misprint: false }, { exactOnly: true });
    expect(found).toBeNull();

    // Looking for Holo with exactOnly: true strictly returns null
    const foundHolo = findPackWithCard(KEY, 'right-now', 'tung-tung-sahur', { isHolo: true, finish: null, misprint: false }, { exactOnly: true });
    expect(foundHolo).toBeNull();
  });

  it('returns the exact pack when exactOnly is true and variant is present', () => {
    recordPack(pack(1, {
      cards: [{ id: 'tung-tung-sahur', isHolo: false, finish: null, misprint: false }] as unknown as OpenedPack['cards'],
    }));
    recordPack(pack(2, {
      cards: [{ id: 'tung-tung-sahur', isHolo: false, finish: 'SILVER', misprint: false }] as unknown as OpenedPack['cards'],
    }));

    const found = findPackWithCard(KEY, 'right-now', 'tung-tung-sahur', { isHolo: false, finish: 'SILVER', misprint: false }, { exactOnly: true });
    expect(found?.nonce).toBe(2);
  });

  it('filters by setVersion when provided', () => {
    recordPack(pack(1, {
      setVersion: 1,
      cards: [{ id: 'tung-tung-sahur', isHolo: false, finish: null, misprint: false }] as unknown as OpenedPack['cards'],
    }));
    recordPack(pack(2, {
      setVersion: 2,
      cards: [{ id: 'tung-tung-sahur', isHolo: false, finish: null, misprint: false }] as unknown as OpenedPack['cards'],
    }));

    expect(findPackWithCard(KEY, 'right-now', 'tung-tung-sahur', { isHolo: false }, { setVersion: 1 })?.nonce).toBe(1);
    expect(findPackWithCard(KEY, 'right-now', 'tung-tung-sahur', { isHolo: false }, { setVersion: 2 })?.nonce).toBe(2);
    expect(findPackWithCard(KEY, 'right-now', 'tung-tung-sahur', { isHolo: false }, { setVersion: 3 })).toBeNull();
  });
});
