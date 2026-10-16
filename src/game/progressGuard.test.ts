// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { guardProgress, watchProgress } from './progressGuard';

const stats = (packsOpened: number) =>
  JSON.stringify({ packsOpened, holoCards: {}, highestPackValue: 0, highestPackCards: [] });

// A tab stores its progress the way App does: only while the guard says storage still holds what it read.
const storeIfCurrent = (guard: ReturnType<typeof guardProgress>, key: string, value: string): boolean => {
  if (!guard.current()) return false;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Out of space: the tab keeps its progress and retries later.
  }
  guard.noted();
  return true;
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(STORAGE_KEYS.STATS, stats(1));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('guardProgress', () => {
  it('lets a tab keep storing its own writes', () => {
    const tab = guardProgress();
    expect(storeIfCurrent(tab, STORAGE_KEYS.STATS, stats(2))).toBe(true);
    expect(storeIfCurrent(tab, STORAGE_KEYS.STATS, stats(3))).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.STATS)).toBe(stats(3));
  });

  it('stops the second of two interleaving tabs from storing over the first', () => {
    const a = guardProgress();
    const b = guardProgress();
    expect(storeIfCurrent(a, STORAGE_KEYS.STATS, stats(2))).toBe(true);
    // b read the save before a stored its pack: what b holds is older now.
    expect(b.current()).toBe(false);
    expect(storeIfCurrent(b, STORAGE_KEYS.STATS, stats(2))).toBe(false);
    expect(localStorage.getItem(STORAGE_KEYS.STATS)).toBe(stats(2));
    // a keeps going: storage holds what it stored.
    expect(storeIfCurrent(a, STORAGE_KEYS.STATS, stats(3))).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.STATS)).toBe(stats(3));
  });

  it('notices another tab recording a pack in any of the progress it stores whole', () => {
    for (const key of [STORAGE_KEYS.COLLECTION, STORAGE_KEYS.STATS, STORAGE_KEYS.HALL_OF_FAME, STORAGE_KEYS.ACHIEVEMENTS]) {
      const stale = guardProgress();
      localStorage.setItem(key, `{"from":"another tab","key":"${key}"}`);
      expect(stale.current()).toBe(false);
    }
  });

  it('notices storage cleared by another tab', () => {
    const stale = guardProgress();
    localStorage.clear();
    expect(stale.current()).toBe(false);
  });

  it('ignores settings, the history and the pending shelf, which are not stored whole from load', () => {
    const tab = guardProgress();
    localStorage.setItem(STORAGE_KEYS.SETTINGS, '{"musicVolume":0}');
    localStorage.setItem(STORAGE_KEYS.HISTORY, '[]');
    localStorage.setItem(STORAGE_KEYS.PENDING_PACKS, '[]');
    expect(tab.current()).toBe(true);
  });

  it('stays current after its own write fails for space, and still notices a later write by another tab', () => {
    const tab = guardProgress();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(storeIfCurrent(tab, STORAGE_KEYS.STATS, stats(2))).toBe(true);
    // The write didn't land: storage still holds what the tab read, so it is not stale and retries.
    expect(localStorage.getItem(STORAGE_KEYS.STATS)).toBe(stats(1));
    expect(tab.current()).toBe(true);
    expect(storeIfCurrent(tab, STORAGE_KEYS.STATS, stats(2))).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.STATS)).toBe(stats(2));
    localStorage.setItem(STORAGE_KEYS.STATS, stats(9));
    expect(tab.current()).toBe(false);
  });

  it('treats unreadable storage as holding nothing instead of throwing', () => {
    localStorage.clear();
    const tab = guardProgress();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(tab.current()).toBe(true);
  });
});

describe('watchProgress', () => {
  it('reports another tab writing guarded progress or clearing storage, not settings', () => {
    const onChange = vi.fn();
    const stop = watchProgress(onChange);
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEYS.SETTINGS }));
    expect(onChange).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEYS.COLLECTION }));
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEYS.STATS }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
