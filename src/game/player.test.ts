import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';

const PLAYER_KEY = 'brainrot-player-v1';
const identity = (secretKey = 'aa'.repeat(32), nextNonce = 7, name = 'Incoming Player') => ({ secretKey, name, nextNonce, createdAt: 1 });
const original = identity('bb'.repeat(32), 12, 'Original Player');
const store = new Map<string, string>();
const getItem = vi.fn((key: string) => store.get(key) ?? null);
const setItem = vi.fn((key: string, value: string) => { store.set(key, value); });
let player: typeof import('./player');

beforeEach(async () => {
  vi.resetModules();
  store.clear();
  getItem.mockReset().mockImplementation((key: string) => store.get(key) ?? null);
  setItem.mockReset().mockImplementation((key: string, value: string) => { store.set(key, value); });
  vi.stubGlobal('localStorage', {
    get length() { return store.size; },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem, setItem,
    removeItem: (key: string) => { store.delete(key); },
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  player = await import('./player');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const denyIdentityWrites = () => {
  setItem.mockImplementation((key, value) => {
    if (key === PLAYER_KEY) throw new Error('Identity storage denied');
    store.set(key, value);
  });
};

describe('durable player imports', () => {
  it.each([['different key', identity()], ['same key with a newer counter', identity(original.secretKey, 30)]])('retains stored and memory identity on a failed import: %s', (_label, incoming) => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const before = player.getPlayer();
    expect(player.peekNonce()).toBe(12);
    denyIdentityWrites();

    expect(player.importPlayer(JSON.stringify(incoming))).toBe(false);
    expect(store.get(PLAYER_KEY)).toBe(JSON.stringify(original));
    // Reading storage is now denied: this must still use the unchanged memory fallback.
    getItem.mockImplementation(() => { throw new Error('Storage read denied'); });
    expect(player.getPlayer().publicKeyHex).toBe(before.publicKeyHex);
    expect(JSON.parse(player.exportPlayer())).toEqual(original);
    expect(player.peekNonce()).toBe(12);
  });

  it('does not create a guest identity while attempting a failed import into an empty browser', () => {
    const incoming = identity();
    denyIdentityWrites();
    expect(player.importPlayer(JSON.stringify(incoming))).toBe(false);
    expect(setItem).toHaveBeenCalledExactlyOnceWith(PLAYER_KEY, JSON.stringify(incoming));
    expect(store.size).toBe(0);

    // A subsequent normal visit creates its own guest rather than using the failed imported record.
    setItem.mockImplementation((key, value) => { store.set(key, value); });
    expect(player.peekNonce()).toBe(0);
    expect(JSON.parse(store.get(PLAYER_KEY)!).nextNonce).toBe(0);
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it('preserves the normal guest/counter memory fallback when storage is unavailable', () => {
    getItem.mockImplementation(() => { throw new Error('Storage read denied'); });
    denyIdentityWrites();
    const guest = player.getPlayer();
    const allocated = player.allocateNonce();
    expect(allocated.nonce).toBe(0);
    expect(allocated.player.publicKeyHex).toBe(guest.publicKeyHex);
    expect(player.peekNonce()).toBe(1);

    expect(player.importPlayer(JSON.stringify(identity()))).toBe(false);
    expect(player.getPlayer().publicKeyHex).toBe(guest.publicKeyHex);
    expect(player.peekNonce()).toBe(1);
  });

  it('persists a successful import before exposing the new memory identity', () => {
    const incoming = identity();
    setItem.mockImplementation((key, value) => {
      if (key === PLAYER_KEY) expect(store.has(PLAYER_KEY)).toBe(false);
      store.set(key, value);
    });
    expect(player.importPlayer(JSON.stringify(incoming))).toBe(true);
    expect(store.get(PLAYER_KEY)).toBe(JSON.stringify(incoming));
    getItem.mockImplementation(() => { throw new Error('Storage read denied'); });
    expect(JSON.parse(player.exportPlayer())).toEqual(incoming);
    expect(player.peekNonce()).toBe(7);
    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it('keeps the persisted nonce floor for a successful same-key import', () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const incoming = identity(original.secretKey, 3, 'Renamed');
    expect(player.importPlayer(JSON.stringify(incoming))).toBe(true);
    expect(JSON.parse(store.get(PLAYER_KEY)!)).toEqual({ ...incoming, nextNonce: 12 });
    expect(player.peekNonce()).toBe(12);
  });

  it('uses the newer memory nonce floor when the storage read is unavailable', () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    expect(player.peekNonce()).toBe(12);
    getItem.mockImplementation(() => { throw new Error('Storage read denied'); });
    const incoming = identity(original.secretKey, 3);
    expect(player.importPlayer(JSON.stringify(incoming))).toBe(true);
    expect(JSON.parse(store.get(PLAYER_KEY)!)).toEqual({ ...incoming, nextNonce: 12 });
    expect(player.peekNonce()).toBe(12);
  });

  it('returns a save-file error when valid incoming identity persistence fails', async () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const before = player.getPlayer();
    denyIdentityWrites();
    const { importSaveFile } = await import('./saveFile');
    const error = importSaveFile(JSON.stringify({
      version: 2, exportedAt: '2026-10-14T00:00:00Z',
      player: JSON.stringify(identity()), stats: '{"packsOpened":1,"holoCards":{}}',
    }));
    expect(error).toBe('Import failed. Your previous save data was restored.');
    expect(store.get(PLAYER_KEY)).toBe(JSON.stringify(original));
    expect(player.getPlayer().publicKeyHex).toBe(before.publicKeyHex);
    expect(store.has(STORAGE_KEYS.STATS)).toBe(false);
    expect(store.has('brainrot-data-version')).toBe(false);
  });
});
