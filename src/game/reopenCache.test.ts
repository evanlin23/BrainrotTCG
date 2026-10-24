import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSet } from '../content/sets';
import { encodeCard } from './cardCode';
import {
  __resetReopenCacheForTests as resetReopenCache,
  flushReopenCache,
  getReopened,
  MAX_REOPEN_CACHE_ENTRIES,
  putReopened,
  REOPEN_CACHE_KEY,
} from './reopenCache';
import type { PulledCard } from '../engine';

const data = new Map<string, string>();
const storage = {
  getItem: vi.fn((k: string) => data.get(k) ?? null),
  setItem: vi.fn((k: string, v: string) => void data.set(k, v)),
  removeItem: vi.fn((k: string) => void data.delete(k)),
};
vi.stubGlobal('localStorage', storage);

describe('reopenCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    data.clear();
    storage.getItem.mockImplementation((k: string) => data.get(k) ?? null);
    storage.setItem.mockImplementation((k: string, v: string) => void data.set(k, v));
    storage.removeItem.mockImplementation((k: string) => void data.delete(k));
    resetReopenCache();
  });

  afterEach(() => {
    resetReopenCache();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('still reads entries saved under `${id}@${version}|${public key}|${nonce}`', () => {
    const set = getSet('genesis', 1)!;
    const key = 'ab'.repeat(32);
    const card = set.cards[0];
    data.set(REOPEN_CACHE_KEY, JSON.stringify({ [`genesis@1|${key}|7`]: encodeCard({ id: card.id, holo: true }) }));
    expect(getReopened(set, key, 7)).toEqual([{ setId: 'genesis', cardId: card.id, rarity: card.rarity, isHolo: true, slot: 0 }]);
  });

  it('after a quota failure removes its key and stays memory-only, never rewriting into freed space', () => {
    const set = getSet('genesis', 1)!;
    const key = 'ab'.repeat(32);
    const card = set.cards[0];
    const cards: PulledCard[] = [{ setId: 'genesis', cardId: card.id, rarity: card.rarity, isHolo: false, slot: 0 }];
    data.set(REOPEN_CACHE_KEY, JSON.stringify({ [`genesis@1|${key}|0`]: encodeCard({ id: card.id, holo: false }) }));
    storage.setItem.mockImplementation(() => {
      throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    });

    putReopened(set, key, 1, cards);
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.removeItem).toHaveBeenCalledWith(REOPEN_CACHE_KEY);
    expect(data.has(REOPEN_CACHE_KEY)).toBe(false);

    // Space is free again (a save could use it), but the cache must not write itself back.
    storage.setItem.mockImplementation((k: string, v: string) => void data.set(k, v));
    putReopened(set, key, 2, cards);
    vi.advanceTimersByTime(1000);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(data.has(REOPEN_CACHE_KEY)).toBe(false);

    // The memory-only fallback still serves everything it holds.
    expect(getReopened(set, key, 0)).toEqual(cards);
    expect(getReopened(set, key, 1)).toEqual(cards);
    expect(getReopened(set, key, 2)).toEqual(cards);
  });

  it('keeps the memory-only fallback capped at MAX_REOPEN_CACHE_ENTRIES', () => {
    const set = getSet('genesis', 1)!;
    const key = '56'.repeat(32);
    const card = set.cards[0];
    const cards: PulledCard[] = [{ setId: 'genesis', cardId: card.id, rarity: card.rarity, isHolo: false, slot: 0 }];
    storage.setItem.mockImplementation(() => {
      throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    });

    putReopened(set, key, 0, cards);
    vi.advanceTimersByTime(1000);
    for (let i = 1; i <= MAX_REOPEN_CACHE_ENTRIES; i++) putReopened(set, key, i, cards);

    expect(getReopened(set, key, 0)).toBeNull();
    expect(getReopened(set, key, 1)).toEqual(cards);
    expect(getReopened(set, key, MAX_REOPEN_CACHE_ENTRIES)).toEqual(cards);
  });

  it('contains storage denial when both setItem and removeItem fail, avoiding uncaught timer errors', () => {
    storage.setItem.mockImplementation(() => {
      throw new DOMException('Storage denied', 'SecurityError');
    });
    storage.removeItem.mockImplementation(() => {
      throw new DOMException('Storage denied', 'SecurityError');
    });

    const set = getSet('genesis', 1)!;
    const key = 'cd'.repeat(32);
    const card = set.cards[1];
    const cards: PulledCard[] = [{ setId: 'genesis', cardId: card.id, rarity: card.rarity, isHolo: true, slot: 0 }];

    putReopened(set, key, 2, cards);

    // Advancing timers executes the scheduled flush without throwing
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(storage.setItem).toHaveBeenCalled();
    expect(storage.removeItem).toHaveBeenCalledWith(REOPEN_CACHE_KEY);

    // Memory cache remains functional
    expect(getReopened(set, key, 2)).toEqual(cards);
  });

  it('handles storage getter denial gracefully and serves from memory', () => {
    storage.getItem.mockImplementation(() => {
      throw new DOMException('Storage access denied', 'SecurityError');
    });

    const set = getSet('genesis', 1)!;
    const key = 'ef'.repeat(32);

    expect(getReopened(set, key, 3)).toBeNull();

    const card = set.cards[2];
    const cards: PulledCard[] = [{ setId: 'genesis', cardId: card.id, rarity: card.rarity, isHolo: false, slot: 0 }];
    putReopened(set, key, 3, cards);

    expect(getReopened(set, key, 3)).toEqual(cards);
  });

  it('contains a throwing localStorage getter on load, flush and cleanup', () => {
    const set = getSet('genesis', 1)!;
    const key = '78'.repeat(32);
    const card = set.cards[0];
    const cards: PulledCard[] = [{ setId: 'genesis', cardId: card.id, rarity: card.rarity, isHolo: false, slot: 0 }];
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('Storage access denied', 'SecurityError');
      },
    });
    try {
      expect(getReopened(set, key, 4)).toBeNull();
      putReopened(set, key, 4, cards);
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
      expect(getReopened(set, key, 4)).toEqual(cards);
    } finally {
      vi.stubGlobal('localStorage', storage);
    }
  });

  it('successfully flushes to storage and bounds cache entries to MAX_REOPEN_CACHE_ENTRIES', () => {
    const set = getSet('genesis', 1)!;
    const key = '12'.repeat(32);
    const card = set.cards[0];
    const cards: PulledCard[] = [{ setId: 'genesis', cardId: card.id, rarity: card.rarity, isHolo: false, slot: 0 }];

    putReopened(set, key, 10, cards);
    expect(data.has(REOPEN_CACHE_KEY)).toBe(false);

    // After 1000ms flush writes to localStorage
    vi.advanceTimersByTime(1000);
    expect(data.has(REOPEN_CACHE_KEY)).toBe(true);

    const parsed = JSON.parse(data.get(REOPEN_CACHE_KEY)!) as Record<string, string>;
    expect(Object.keys(parsed)).toHaveLength(1);
    expect(getReopened(set, key, 10)).toEqual(cards);
  });

  it('writes a pending change at once when flushed and cancels its timer, so nothing runs after teardown', () => {
    const set = getSet('genesis', 1)!;
    const key = '9a'.repeat(32);
    const card = set.cards[0];
    const cards: PulledCard[] = [{ setId: 'genesis', cardId: card.id, rarity: card.rarity, isHolo: false, slot: 0 }];

    putReopened(set, key, 11, cards);
    expect(vi.getTimerCount()).toBe(1);
    flushReopenCache();
    expect(vi.getTimerCount()).toBe(0);
    expect(Object.keys(JSON.parse(data.get(REOPEN_CACHE_KEY)!) as object)).toEqual([`genesis@1|${key}|11`]);
    expect(storage.setItem).toHaveBeenCalledOnce();
  });

  it('enforces size limits by evicting oldest entries when MAX_REOPEN_CACHE_ENTRIES is exceeded', () => {
    const set = getSet('genesis', 1)!;
    const key = '34'.repeat(32);
    const card = set.cards[0];
    const cards: PulledCard[] = [{ setId: 'genesis', cardId: card.id, rarity: card.rarity, isHolo: false, slot: 0 }];

    // Seed data with MAX_REOPEN_CACHE_ENTRIES entries
    const existing: Record<string, string> = {};
    for (let i = 0; i < MAX_REOPEN_CACHE_ENTRIES; i++) {
      existing[`genesis@1|${key}|${i}`] = encodeCard({ id: card.id, holo: false });
    }
    data.set(REOPEN_CACHE_KEY, JSON.stringify(existing));

    // Adding entry MAX_REOPEN_CACHE_ENTRIES should evict entry 0
    putReopened(set, key, MAX_REOPEN_CACHE_ENTRIES, cards);
    vi.advanceTimersByTime(1000);

    expect(getReopened(set, key, 0)).toBeNull();
    expect(getReopened(set, key, MAX_REOPEN_CACHE_ENTRIES)).toEqual(cards);

    const stored = JSON.parse(data.get(REOPEN_CACHE_KEY)!) as Record<string, string>;
    expect(Object.keys(stored).length).toBeLessThanOrEqual(MAX_REOPEN_CACHE_ENTRIES);
  });
});
