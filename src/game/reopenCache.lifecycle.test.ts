// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSet } from '../content/sets';
import type { PulledCard } from '../engine';
import {
  __resetReopenCacheForTests as resetReopenCache,
  flushReopenCache,
  getReopened,
  putReopened,
  REOPEN_CACHE_KEY,
} from './reopenCache';

const set = getSet('genesis', 1)!;
const key = 'ab'.repeat(32);
const card = set.cards[0];
const cards: PulledCard[] = [{ setId: 'genesis', cardId: card.id, rarity: card.rarity, isHolo: false, slot: 0 }];
// jsdom queues a storage event on a timer for every write, so these tests count writes, not pending timers.
const writes = () => vi.spyOn(Storage.prototype, 'setItem');
const storedNonces = (): string[] => Object.keys(JSON.parse(localStorage.getItem(REOPEN_CACHE_KEY) ?? '{}') as object).map((k) => k.split('|')[2]);

let visibility: DocumentVisibilityState = 'visible';
const goHidden = () => {
  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetReopenCache();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  resetReopenCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  Reflect.deleteProperty(document, 'visibilityState');
});

describe('a pending reopen-cache write', () => {
  it('lands in storage at once when flushed, leaving no timer to write again later', () => {
    const setItem = writes();
    putReopened(set, key, 1, cards);
    flushReopenCache();
    expect(storedNonces()).toEqual(['1']);
    vi.runAllTimers();
    expect(setItem).toHaveBeenCalledOnce();
  });

  it('lands when the tab closes inside its one-second wait', () => {
    const setItem = writes();
    putReopened(set, key, 2, cards);
    window.dispatchEvent(new Event('pagehide'));
    expect(storedNonces()).toEqual(['2']);
    vi.runAllTimers();
    expect(setItem).toHaveBeenCalledOnce();
  });

  it('lands when the page goes hidden, but not on a visibility change that leaves it showing', () => {
    const setItem = writes();
    putReopened(set, key, 3, cards);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(setItem).not.toHaveBeenCalled();
    goHidden();
    expect(storedNonces()).toEqual(['3']);
    vi.runAllTimers();
    expect(setItem).toHaveBeenCalledOnce();
  });

  it('still lands on its one-second schedule while the page stays open, and the next write waits again', () => {
    putReopened(set, key, 4, cards);
    vi.advanceTimersByTime(999);
    expect(localStorage.getItem(REOPEN_CACHE_KEY)).toBeNull();
    vi.advanceTimersByTime(1);
    expect(storedNonces()).toEqual(['4']);

    // Its page-hide listener went with that write; the next write arms a fresh one.
    const setItem = writes();
    window.dispatchEvent(new Event('pagehide'));
    expect(setItem).not.toHaveBeenCalled();
    putReopened(set, key, 5, cards);
    window.dispatchEvent(new Event('pagehide'));
    expect(storedNonces()).toEqual(['4', '5']);
  });

  it('does nothing when flushed with nothing pending', () => {
    const setItem = writes();
    flushReopenCache();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('keeps the quota recovery when the flush is the one that hits it: frees its key and stays memory-only', () => {
    localStorage.setItem(REOPEN_CACHE_KEY, '{}');
    const setItem = writes().mockImplementation(() => {
      throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
    });
    putReopened(set, key, 6, cards);
    // dispatchEvent never rethrows a listener's error; jsdom reports it on the window instead.
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener('error', onError);
    window.dispatchEvent(new Event('pagehide'));
    window.removeEventListener('error', onError);
    expect(errors).toEqual([]);
    expect(localStorage.getItem(REOPEN_CACHE_KEY)).toBeNull();

    // Memory-only: a later write arms no timed or page-hide write.
    putReopened(set, key, 7, cards);
    window.dispatchEvent(new Event('pagehide'));
    vi.runAllTimers();
    expect(setItem).toHaveBeenCalledOnce();
    expect(localStorage.getItem(REOPEN_CACHE_KEY)).toBeNull();
    expect(getReopened(set, key, 7)).toEqual(cards);
  });
});
