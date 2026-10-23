import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { markOpenCueUnderstood, OPEN_CUE_MAX_PLAYS, readOpenCuePlays, recordOpenCuePlay } from './openCue';

const data = new Map<string, string>();

beforeEach(() => {
  data.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('the opening cue\'s play count', () => {
  it('starts at none and counts each play up to the most', () => {
    expect(readOpenCuePlays()).toBe(0);
    recordOpenCuePlay();
    expect(readOpenCuePlays()).toBe(1);
    for (let i = 0; i < 5; i++) recordOpenCuePlay();
    expect(readOpenCuePlays()).toBe(OPEN_CUE_MAX_PLAYS);
    expect(data.get(STORAGE_KEYS.OPEN_CUE_PLAYS)).toBe(String(OPEN_CUE_MAX_PLAYS));
  });

  it('is done for good once the player understands', () => {
    markOpenCueUnderstood();
    expect(readOpenCuePlays()).toBe(OPEN_CUE_MAX_PLAYS);
  });

  it.each(['garbage', '-1', '1.5', 'NaN'])('counts an unreadable value (%s) as played, so the cue never loops', (value) => {
    data.set(STORAGE_KEYS.OPEN_CUE_PLAYS, value);
    expect(readOpenCuePlays()).toBe(OPEN_CUE_MAX_PLAYS);
  });

  it('counts unreadable storage as played, and survives storage that refuses a write', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new DOMException('denied', 'SecurityError'); },
      setItem: () => { throw new DOMException('full', 'QuotaExceededError'); },
    });
    expect(readOpenCuePlays()).toBe(OPEN_CUE_MAX_PLAYS);
    expect(() => recordOpenCuePlay()).not.toThrow();
    expect(() => markOpenCueUnderstood()).not.toThrow();
  });
});
