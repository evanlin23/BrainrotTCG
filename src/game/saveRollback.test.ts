import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { ALL_CARDS } from '../data/cards';

const PLAYER_KEY = 'brainrot-player-v1';
const VERSION_KEY = 'brainrot-data-version';
const BACKUP_KEY = 'brainrot-before-import-v1';
const identity = (key: string, nextNonce: number) => JSON.stringify({ secretKey: key.repeat(32), name: 'Test Player', nextNonce, createdAt: 1 });
const store = new Map<string, string>();
const setItem = vi.fn((key: string, value: string) => { store.set(key, value); });
const removeItem = vi.fn((key: string) => { store.delete(key); });
let importSaveFile: typeof import('./saveFile').importSaveFile;
let player: typeof import('./player');
let backUpSave: typeof import('./saveFile').backUpSave;
let NO_COPY_NOTE: string;

const fixture = () => ({
  version: 2, dataVersion: 3, exportedAt: '2026-10-14T00:00:00Z',
  collection: '{}', achievements: '{"new":2}', stats: '{"packsOpened":3,"holoCards":{}}',
  settings: '{"effectsVolume":0.6}', player: identity('aa', 3),
});
const INCOMPLETE = "Import failed partway and couldn't be fully undone, so this browser may now hold parts of both saves."
  + ' A copy of the save from before the import is kept in this browser.';
const withoutBackup = () => new Map([...store].filter(([key]) => key !== BACKUP_KEY));
const expectBackup = (original: Map<string, string>) => {
  expect(new Map(Object.entries(JSON.parse(store.get(BACKUP_KEY)!)))).toEqual(original);
};

beforeEach(async () => {
  vi.resetModules();
  store.clear();
  setItem.mockReset().mockImplementation((key, value) => { store.set(key, value); });
  removeItem.mockReset().mockImplementation((key) => { store.delete(key); });
  vi.stubGlobal('localStorage', {
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem, removeItem,
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  store.set(PLAYER_KEY, identity('bb', 8));
  store.set(STORAGE_KEYS.COLLECTION, JSON.stringify({ [ALL_CARDS[0].key]: { card: ALL_CARDS[0], normalCount: 2, holoCount: 0 } }));
  store.set(STORAGE_KEYS.ACHIEVEMENTS, '{"old":1}');
  store.set(STORAGE_KEYS.STATS, '{"packsOpened":8,"holoCards":{}}');
  store.set(STORAGE_KEYS.SETTINGS, '{"effectsVolume":0.1}');
  store.set(VERSION_KEY, '1');
  ({ importSaveFile, backUpSave, NO_COPY_NOTE } = await import('./saveFile'));
  player = await import('./player');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('synchronous Settings import recovery', () => {
  it.each([
    ['second field', STORAGE_KEYS.ACHIEVEMENTS],
    ['late field', STORAGE_KEYS.SETTINGS],
    ['version metadata', VERSION_KEY],
    ['identity', PLAYER_KEY],
  ])('restores original data after a denied %s write', (_label, deniedKey) => {
    const original = new Map(store);
    const originalKey = player.getPlayer().publicKeyHex;
    let failed = false;
    setItem.mockImplementation((key, value) => {
      if (key === deniedKey && !failed) { failed = true; throw new Error('Storage write denied'); }
      store.set(key, value);
    });

    expect(importSaveFile(JSON.stringify(fixture()))).toBe('Import failed. Your previous save data was restored.');
    expect(failed).toBe(true);
    expect(withoutBackup()).toEqual(original);
    expectBackup(original);
    expect(player.getPlayer().publicKeyHex).toBe(originalKey);
    expect(player.peekNonce()).toBe(8);
  });

  it('removes newly introduced fields and metadata when the identity write fails', () => {
    const oldPlayer = store.get(PLAYER_KEY)!;
    store.clear();
    store.set(PLAYER_KEY, oldPlayer);
    const original = new Map(store);
    setItem.mockImplementation((key, value) => {
      if (key === PLAYER_KEY) throw new Error('Identity write denied');
      store.set(key, value);
    });
    expect(importSaveFile(JSON.stringify(fixture()))).toBe('Import failed. Your previous save data was restored.');
    expect(withoutBackup()).toEqual(original);
    expectBackup(original);
  });

  it("restores the previous player's cleared data when adopting another player fails", () => {
    store.set(STORAGE_KEYS.HISTORY, '[]');
    store.set(STORAGE_KEYS.COLLECTION_RECOVERY, JSON.stringify({ raw: '{damaged', player: store.get(PLAYER_KEY) }));
    const original = new Map(store);
    setItem.mockImplementation((key, value) => {
      if (key === PLAYER_KEY) throw new Error('Identity write denied');
      store.set(key, value);
    });
    expect(importSaveFile(JSON.stringify(fixture()))).toBe('Import failed. Your previous save data was restored.');
    expect(removeItem).toHaveBeenCalledWith(STORAGE_KEYS.HISTORY);
    expect(withoutBackup()).toEqual(original);
    expectBackup(original);
  });

  it('does not mention a copy when the browser had no save to back up', () => {
    store.clear();
    let failed = false;
    setItem.mockImplementation((key, value) => {
      if (key === STORAGE_KEYS.STATS && !failed) { failed = true; throw new Error('Import write denied'); }
      store.set(key, value);
    });
    removeItem.mockImplementation((key) => {
      if (key === STORAGE_KEYS.COLLECTION) throw new Error('Recovery removal denied');
      store.delete(key);
    });
    expect(importSaveFile(JSON.stringify(fixture()))).toBe(INCOMPLETE.slice(0, INCOMPLETE.indexOf(' A copy')));
    expect(store.has(BACKUP_KEY)).toBe(false);
  });

  it('returns an initially empty browser to empty after a later field fails', () => {
    store.clear();
    let failed = false;
    setItem.mockImplementation((key, value) => {
      if (key === STORAGE_KEYS.STATS && !failed) { failed = true; throw new Error('Storage write denied'); }
      store.set(key, value);
    });
    expect(importSaveFile(JSON.stringify(fixture()))).toBe('Import failed. Your previous save data was restored.');
    expect(store.size).toBe(0);
    expect(setItem.mock.calls.some(([key]) => key === PLAYER_KEY)).toBe(false);
  });

  it.each(['progress', 'guest', 'settings only'])('aborts before replacement when the %s backup cannot be stored', (kind) => {
    if (kind !== 'progress') {
      store.clear();
      store.set(STORAGE_KEYS.SETTINGS, '{"effectsVolume":0.1}');
      if (kind === 'guest') store.set(PLAYER_KEY, identity('bb', 0));
    }
    const original = new Map(store);
    setItem.mockImplementation((key, value) => {
      if (key === BACKUP_KEY) throw new Error('Backup denied');
      store.set(key, value);
    });
    expect(importSaveFile(JSON.stringify(fixture()))).toBe(NO_COPY_NOTE);
    expect(store).toEqual(original);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem.mock.calls[0][0]).toBe(BACKUP_KEY);
    expect(removeItem).not.toHaveBeenCalled();
  });

  it('does not write a backup when there are no app records', () => {
    store.clear();
    store.set('unrelated', 'keep');
    expect(backUpSave(BACKUP_KEY)).toBe(true);
    expect(setItem).not.toHaveBeenCalled();
    expect(store).toEqual(new Map([['unrelated', 'keep']]));
  });

  it('distinguishes incomplete recovery and retains the private backup when restoration is denied', () => {
    const original = new Map(store);
    let failed = false;
    setItem.mockImplementation((key, value) => {
      if (key === STORAGE_KEYS.SETTINGS && !failed) { failed = true; throw new Error('Import write denied'); }
      if (failed && key === STORAGE_KEYS.COLLECTION) throw new Error('Recovery write denied');
      store.set(key, value);
    });
    expect(importSaveFile(JSON.stringify(fixture()))).toBe(INCOMPLETE);
    expect(store.has(STORAGE_KEYS.COLLECTION)).toBe(false);
    expect(store.get(STORAGE_KEYS.STATS)).toBe(original.get(STORAGE_KEYS.STATS));
    expect(store.get(PLAYER_KEY)).toBe(original.get(PLAYER_KEY));
    expectBackup(original);
  });

  it('reports incomplete recovery when a newly introduced key cannot be removed', () => {
    store.delete(STORAGE_KEYS.ACHIEVEMENTS);
    const original = new Map(store);
    let failed = false;
    setItem.mockImplementation((key, value) => {
      if (key === STORAGE_KEYS.STATS && !failed) { failed = true; throw new Error('Import write denied'); }
      store.set(key, value);
    });
    removeItem.mockImplementation((key) => {
      if (key === STORAGE_KEYS.ACHIEVEMENTS) throw new Error('Recovery removal denied');
      store.delete(key);
    });
    expect(importSaveFile(JSON.stringify(fixture()))).toBe(INCOMPLETE);
    expect(store.get(STORAGE_KEYS.ACHIEVEMENTS)).toBe(fixture().achievements);
    expect(store.get(STORAGE_KEYS.COLLECTION)).toBe(original.get(STORAGE_KEYS.COLLECTION));
    expectBackup(original);
  });

  it('frees all imported values before restoring originals under a controlled quota', () => {
    const oldCard = { ...ALL_CARDS[0], caption: 'old'.repeat(2_000) };
    store.set(STORAGE_KEYS.COLLECTION, JSON.stringify({ [oldCard.key]: { card: oldCard, normalCount: 1, holoCount: 0 } }));
    const original = new Map(store);
    const bytes = (entries: Map<string, string>) => [...entries.values()].reduce((sum, value) => sum + value.length, 0);
    const limit = bytes(store) + JSON.stringify(Object.fromEntries(store)).length;
    const achievements = JSON.stringify(Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`new-${index}`, 1])));
    let failed = false;
    setItem.mockImplementation((key, value) => {
      if (key === STORAGE_KEYS.STATS && !failed) { failed = true; throw new Error('Import write denied'); }
      const next = new Map(store).set(key, value);
      if (bytes(next) > limit) throw new Error('Controlled quota exceeded');
      store.set(key, value);
    });
    expect(importSaveFile(JSON.stringify({ ...fixture(), achievements }))).toBe('Import failed. Your previous save data was restored.');
    expect(withoutBackup()).toEqual(original);
    expectBackup(original);
  });

  it('writes metadata before successfully adopting the imported identity', () => {
    const order: string[] = [];
    setItem.mockImplementation((key, value) => { order.push(key); store.set(key, value); });
    expect(importSaveFile(JSON.stringify(fixture()))).toBeNull();
    expect(order[order.length - 1]).toBe(PLAYER_KEY);
    expect(order.indexOf(VERSION_KEY)).toBeLessThan(order.indexOf(PLAYER_KEY));
    expect(store.get(PLAYER_KEY)).toBe(fixture().player);
    expect(player.peekNonce()).toBe(3);
  });
});
