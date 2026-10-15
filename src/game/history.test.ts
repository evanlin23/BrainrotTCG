import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { byBest, findPackByCards, getHistory, historyForKey, isHallOfFameWorthy, migratePullLog, recordMissing, recordPack, type HistoryEntry } from './history';
import { HALL_OF_FAME_MIN_SCORE } from '../engine';
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
