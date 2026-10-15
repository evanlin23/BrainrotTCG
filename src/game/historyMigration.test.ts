import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getHistory, migratePullLog, recordPack } from './history';
import type { OpenedPack } from './pulls';

const publicKeyHex = 'ab'.repeat(32);
const legacy = (nonce: number, setId = 'genesis', setVersion = 1) => ({
  setId, setVersion, nonce, publicKeyHex, score: 50, hand: 'Pair', openedAt: 1000 + nonce,
});
const existing = {
  ...legacy(0),
  cards: [{ id: 'cached-card', isHolo: true }],
  score: { hand: { name: 'Pair' }, score: 100 },
} as unknown as OpenedPack;
let data: Map<string, string>;
let maxHistoryChars: number;
let failRemove: boolean;

beforeEach(() => {
  data = new Map();
  maxHistoryChars = Infinity;
  failRemove = false;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, raw: string) => {
      if (key === STORAGE_KEYS.HISTORY && raw.length > maxHistoryChars) throw new DOMException('full', 'QuotaExceededError');
      data.set(key, raw);
    },
    removeItem: (key: string) => {
      if (failRemove) throw new DOMException('denied', 'SecurityError');
      data.delete(key);
    },
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function seed(pulls = [legacy(1), legacy(2, 'right-now', 3)]) {
  recordPack(existing);
  data.set(STORAGE_KEYS.PULLS, JSON.stringify(pulls));
  return { history: data.get(STORAGE_KEYS.HISTORY), pulls: data.get(STORAGE_KEYS.PULLS) };
}

function bareHistoryChars(pulls: ReturnType<typeof legacy>[]) {
  return JSON.stringify([
    { s: existing.setId, v: existing.setVersion, n: existing.nonce, k: publicKeyHex.slice(0, 16), h: 'Pair', x: 100, t: existing.openedAt },
    ...pulls.map(pull => ({ s: pull.setId, v: pull.setVersion, n: pull.nonce, k: publicKeyHex.slice(0, 16), h: pull.hand, x: pull.score, t: pull.openedAt })),
  ]).length;
}

describe('lossless legacy pull migration', () => {
  it('keeps both raw logs when every history write fails', () => {
    const original = seed();
    maxHistoryChars = 0;
    migratePullLog();
    expect(data.get(STORAGE_KEYS.HISTORY)).toBe(original.history);
    expect(data.get(STORAGE_KEYS.PULLS)).toBe(original.pulls);
  });

  it('never truncates ticket mappings to fit a mixed-set migration', () => {
    const pulls = [legacy(1), legacy(2, 'right-now', 3), legacy(3, 'unknown-historical-set', 7)];
    const original = seed(pulls);
    // There is room for one or two bare tickets, but not all four.
    maxHistoryChars = bareHistoryChars(pulls) - 1;
    expect(maxHistoryChars).toBeGreaterThan(original.history!.length);
    migratePullLog();
    expect(data.get(STORAGE_KEYS.HISTORY)).toBe(original.history);
    expect(data.get(STORAGE_KEYS.PULLS)).toBe(original.pulls);
    maxHistoryChars = Infinity;
    migratePullLog();
    expect(getHistory().map(({ setId, setVersion, nonce, key }) => ({ setId, setVersion, nonce, key }))).toEqual([
      { setId: 'unknown-historical-set', setVersion: 7, nonce: 3, key: publicKeyHex.slice(0, 16) },
      { setId: 'right-now', setVersion: 3, nonce: 2, key: publicKeyHex.slice(0, 16) },
      { setId: 'genesis', setVersion: 1, nonce: 1, key: publicKeyHex.slice(0, 16) },
      { setId: 'genesis', setVersion: 1, nonce: 0, key: publicKeyHex.slice(0, 16) },
    ]);
    expect(data.has(STORAGE_KEYS.PULLS)).toBe(false);
    migratePullLog();
    expect(getHistory()).toHaveLength(4);
  });

  it('can evict reconstructible card caches while retaining every mapping', () => {
    const pulls = [legacy(1), legacy(2, 'right-now', 3)];
    seed(pulls);
    maxHistoryChars = bareHistoryChars(pulls);
    migratePullLog();
    expect(getHistory().map(entry => entry.nonce)).toEqual([2, 1, 0]);
    expect(getHistory().every(entry => entry.cards === null)).toBe(true);
    expect(data.has(STORAGE_KEYS.PULLS)).toBe(false);
  });

  it('retries a persisted migration without duplicates when old-log removal fails', () => {
    const original = seed([legacy(0), legacy(1), legacy(1)]);
    failRemove = true;
    migratePullLog();
    expect(getHistory().map(entry => entry.nonce)).toEqual([1, 0]);
    expect(getHistory()[1].cards).not.toBeNull();
    expect(data.get(STORAGE_KEYS.PULLS)).toBe(original.pulls);
    failRemove = false;
    migratePullLog();
    expect(getHistory().map(entry => entry.nonce)).toEqual([1, 0]);
    expect(data.has(STORAGE_KEYS.PULLS)).toBe(false);
  });

  it.each(['{', '{}', 'null', '[null]', '[{}]', JSON.stringify([{ ...legacy(1), publicKeyHex: 7 }])])('keeps malformed legacy input intact: %s', raw => {
    seed();
    data.set(STORAGE_KEYS.PULLS, raw);
    const history = data.get(STORAGE_KEYS.HISTORY);
    migratePullLog();
    expect(data.get(STORAGE_KEYS.PULLS)).toBe(raw);
    expect(data.get(STORAGE_KEYS.HISTORY)).toBe(history);
  });

  it.each(['{', '{}', '[null]', '[{"s":"genesis"}]'])('does not overwrite malformed current history: %s', raw => {
    const original = seed();
    data.set(STORAGE_KEYS.HISTORY, raw);
    migratePullLog();
    expect(data.get(STORAGE_KEYS.HISTORY)).toBe(raw);
    expect(data.get(STORAGE_KEYS.PULLS)).toBe(original.pulls);
  });

  it.each([legacy(0, 'right-now'), legacy(0, 'genesis', 2)])('retains contradictory set mappings for recovery', conflict => {
    const original = seed([conflict]);
    migratePullLog();
    expect(data.get(STORAGE_KEYS.HISTORY)).toBe(original.history);
    expect(data.get(STORAGE_KEYS.PULLS)).toBe(original.pulls);
  });

  it('preserves the existing recordPack severe-quota truncation policy', () => {
    seed();
    const bareNewest = [{ s: 'genesis', v: 1, n: 1, k: publicKeyHex.slice(0, 16), h: 'Pair', x: 100, t: 1001 }];
    maxHistoryChars = JSON.stringify(bareNewest).length;
    recordPack({ ...existing, nonce: 1, openedAt: 1001 });
    expect(getHistory().map(entry => entry.nonce)).toEqual([1]);
    expect(getHistory()[0].cards).toBeNull();
  });
});
