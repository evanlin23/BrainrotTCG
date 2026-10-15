import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SET_ID } from '../content/sets';
import { STORAGE_KEYS } from '../constants';
import { readSelectedSet, saveSelectedSet } from './selectedSet';

afterEach(() => vi.unstubAllGlobals());

describe('selected-set preference', () => {
  it('loads an existing raw string without changing its save format', () => {
    const getItem = vi.fn(() => 'spring-breakdown');
    vi.stubGlobal('localStorage', { getItem });
    expect(readSelectedSet()).toBe('spring-breakdown');
    expect(getItem).toHaveBeenCalledExactlyOnceWith(STORAGE_KEYS.SELECTED_SET);
  });

  it('uses the default when the preference is absent', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    expect(readSelectedSet()).toBe(DEFAULT_SET_ID);
  });

  it('uses the default when reading storage is denied', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('blocked', 'SecurityError'); },
    });
    expect(readSelectedSet()).toBe(DEFAULT_SET_ID);
  });

  it('persists the chosen set as the original raw string', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem });
    saveSelectedSet('spring-breakdown');
    expect(setItem).toHaveBeenCalledExactlyOnceWith(STORAGE_KEYS.SELECTED_SET, 'spring-breakdown');
  });

  it('does not interrupt selection or attempt to erase storage when saving fails', () => {
    const removeItem = vi.fn();
    const setItem = vi.fn(() => { throw new DOMException('full', 'QuotaExceededError'); });
    vi.stubGlobal('localStorage', { setItem, removeItem });
    expect(() => saveSelectedSet('spring-breakdown')).not.toThrow();
    expect(setItem).toHaveBeenCalledExactlyOnceWith(STORAGE_KEYS.SELECTED_SET, 'spring-breakdown');
    expect(removeItem).not.toHaveBeenCalled();
  });
});
