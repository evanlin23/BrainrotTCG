import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { FIRST_CARD_CUE_MAX_PLAYS, readFirstCardCuePlays, recordFirstCardCuePlay } from './firstCardCue';

const data = new Map<string, string>();

beforeEach(() => {
  data.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('the first-card cue\'s play count', () => {
  it('plays once on a device: none, then done', () => {
    expect(FIRST_CARD_CUE_MAX_PLAYS).toBe(1);
    expect(readFirstCardCuePlays()).toBe(0);
    recordFirstCardCuePlay();
    recordFirstCardCuePlay();
    expect(readFirstCardCuePlays()).toBe(1);
    expect(data.get(STORAGE_KEYS.FIRST_CARD_CUE_PLAYS)).toBe('1');
  });

  it.each(['garbage', '-1', '1.5', 'NaN'])('counts an unreadable value (%s) as played, so the cue never loops', (value) => {
    data.set(STORAGE_KEYS.FIRST_CARD_CUE_PLAYS, value);
    expect(readFirstCardCuePlays()).toBe(FIRST_CARD_CUE_MAX_PLAYS);
  });

  it('counts unreadable storage as played, and survives storage that refuses a write', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('denied', 'SecurityError'); },
      setItem: () => { throw new DOMException('full', 'QuotaExceededError'); },
    });
    expect(readFirstCardCuePlays()).toBe(FIRST_CARD_CUE_MAX_PLAYS);
    expect(() => recordFirstCardCuePlay()).not.toThrow();
  });
});
