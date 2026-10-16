import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { fromHex, publicKeyFromSecret, toHex } from '../engine';

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

describe('renaming the player', () => {
  beforeEach(() => store.set(PLAYER_KEY, JSON.stringify(original)));
  const ORIGINAL_KEY = toHex(publicKeyFromSecret(fromHex(original.secretKey)));
  const nameOf = (result: import('./player').RenameResult) => ('player' in result ? result.player.name : null);

  it('stores a changed name on the current record, keeping its key and ticket counter', () => {
    const result = player.renamePlayer('  New   Name ', ORIGINAL_KEY);
    expect(result.status).toBe('saved');
    expect(nameOf(result)).toBe('New Name');
    expect(JSON.parse(store.get(PLAYER_KEY)!)).toEqual({ ...original, name: 'New Name' });
    expect(player.getPlayer().name).toBe('New Name');
  });

  it.each([
    ['quota', new DOMException('Quota exceeded', 'QuotaExceededError')],
    ['security', new DOMException('Storage blocked', 'SecurityError')],
  ])('reports a refused write (%s) and keeps the stored name', (_label, error) => {
    setItem.mockImplementation(() => { throw error; });
    const result = player.renamePlayer('New Name', ORIGINAL_KEY);
    expect(result.status).toBe('failed');
    expect(nameOf(result)).toBe('Original Player');
    expect(store.get(PLAYER_KEY)).toBe(JSON.stringify(original));
    expect(player.getPlayer().name).toBe('Original Player');
    // Not even the in-memory fallback adopts the name when storage later becomes unreadable.
    getItem.mockImplementation(() => { throw new Error('Storage read denied'); });
    expect(player.getPlayer().name).toBe('Original Player');
  });

  it.each([['blank', '   '], ['unchanged', ' Original  Player ']])('writes nothing for a %s name', (status, name) => {
    const result = player.renamePlayer(name, ORIGINAL_KEY);
    expect(result.status).toBe(status);
    expect(nameOf(result)).toBe('Original Player');
    expect(setItem).not.toHaveBeenCalled();
  });

  it('writes nothing when another player is stored now, and hands that player back to no one', () => {
    const theirs = identity('cc'.repeat(32), 5, 'Their Player');
    store.set(PLAYER_KEY, JSON.stringify(theirs));
    const result = player.renamePlayer('My New Name', ORIGINAL_KEY);
    expect(result).toEqual({ status: 'stale' });
    expect(setItem).not.toHaveBeenCalled();
    expect(store.get(PLAYER_KEY)).toBe(JSON.stringify(theirs));
  });
});

describe('watching the player from other tabs', () => {
  it('calls back when another tab stores a player or clears storage, and stops once unsubscribed', () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const storageEvent = (key: string | null) => target.dispatchEvent(Object.assign(new Event('storage'), { key }));
    const onChange = vi.fn();
    const stop = player.watchPlayer(onChange);

    storageEvent(STORAGE_KEYS.COLLECTION);
    expect(onChange).not.toHaveBeenCalled();
    storageEvent(PLAYER_KEY);
    storageEvent(null);
    expect(onChange).toHaveBeenCalledTimes(2);

    stop();
    storageEvent(PLAYER_KEY);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('claiming the next ticket number', () => {
  const ORIGINAL_KEY = toHex(publicKeyFromSecret(fromHex(original.secretKey)));
  const stored = () => JSON.parse(store.get(PLAYER_KEY)!);
  /**
   * Web Locks as a browser grants them: one holder per name, across tabs, until its callback settles. A
   * request waits for the holder to let go, or with ifAvailable is turned away at once.
   */
  const fakeLocks = (beforeGrant?: (name: string) => void) => {
    const held = new Set<string>();
    const request = vi.fn(async (name: string, options: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => unknown) => {
      await Promise.resolve();
      while (held.has(name) && !options.ifAvailable) await new Promise((resolve) => setTimeout(resolve, 0));
      if (held.has(name)) return callback(null);
      held.add(name);
      beforeGrant?.(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    });
    const query = vi.fn(async () => ({ held: [...held].map((name) => ({ name, mode: 'exclusive' as const })), pending: [] }));
    return { held, request, query };
  };

  /** Tab A opens a pack, then tab B, whose view of storage still lags behind A's write (as another process's cache can). */
  const twoTabs = async () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const lagging = new Map(store);
    let view = store;
    getItem.mockImplementation((key: string) => view.get(key) ?? null);
    setItem.mockImplementation((key: string, value: string) => { view.set(key, value); });
    vi.resetModules();
    const tabA = await import('./player');
    vi.resetModules();
    const tabB = await import('./player');
    const first = await tabA.claimNonce();
    view = lagging;
    const second = await tabB.claimNonce();
    return { nonces: [first.nonce, second.nonce], second, lagging };
  };

  it('never gives two tabs the same number, even when one reads storage from before the other wrote', async () => {
    // Without Web Locks the lagging tab hands out the same number again: the race the locks close.
    vi.stubGlobal('navigator', {});
    expect((await twoTabs()).nonces).toEqual([12, 12]);

    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    const { nonces, second, lagging } = await twoTabs();
    expect(nonces).toEqual([12, 13]);
    expect(second.player.publicKeyHex).toBe(ORIGINAL_KEY);
    expect(JSON.parse(lagging.get(PLAYER_KEY)!).nextNonce).toBe(14);
    // Each number stays held while its tab is open.
    expect(locks.held).toEqual(new Set([`brainrot-ticket:${ORIGINAL_KEY}:12`, `brainrot-ticket:${ORIGINAL_KEY}:13`]));
  });

  it('holds only the lock of the highest number a tab took, so held locks stop growing', async () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    for (const expected of [12, 13, 14]) expect((await player.claimNonce()).nonce).toBe(expected);
    await vi.waitFor(() => expect(locks.held).toEqual(new Set([`brainrot-ticket:${ORIGINAL_KEY}:14`])));
  });

  it('never gives a lagging tab a number below a lock another tab still holds, once lower ones are let go', async () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const lagging = new Map(store);
    let view = store;
    getItem.mockImplementation((key: string) => view.get(key) ?? null);
    setItem.mockImplementation((key: string, value: string) => { view.set(key, value); });
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    vi.resetModules();
    const tabA = await import('./player');
    vi.resetModules();
    const tabB = await import('./player');
    expect([(await tabA.claimNonce()).nonce, (await tabA.claimNonce()).nonce]).toEqual([12, 13]);
    // 12's lock is free again, but B, still reading 12 from storage, must not take it.
    await vi.waitFor(() => expect(locks.held).toEqual(new Set([`brainrot-ticket:${ORIGINAL_KEY}:13`])));
    view = lagging;
    expect((await tabB.claimNonce()).nonce).toBe(14);
    expect(JSON.parse(lagging.get(PLAYER_KEY)!).nextNonce).toBe(15);
  });

  it('gives calls in one tab different numbers when they run at once', async () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    vi.stubGlobal('navigator', { locks: fakeLocks() });
    const claims = await Promise.all([player.claimNonce(), player.claimNonce()]);
    expect(claims.map((c) => [c.nonce, c.stored])).toEqual([[12, true], [13, true]]);
    expect(stored().nextNonce).toBe(14);
  });

  it('leaves no number unused when two tabs claim at once', async () => {
    // A number skipped is a gap in the history, and a profile proof can't cover a gap.
    store.set(PLAYER_KEY, JSON.stringify(original));
    const locks = fakeLocks();
    // A slow query() leaves time for the other tab's claim to start meanwhile.
    const query = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); return locks.query(); });
    vi.stubGlobal('navigator', { locks: { request: locks.request, query } });
    vi.resetModules();
    const tabA = await import('./player');
    vi.resetModules();
    const tabB = await import('./player');
    const claims = await Promise.all([tabA.claimNonce(), tabB.claimNonce()]);
    expect(claims.map((c) => c.nonce).sort((a, b) => a - b)).toEqual([12, 13]);
    expect(stored().nextNonce).toBe(14);
  });

  it('still takes turns and never repeats a number where Web Locks lack query(), falling back from the last number tried', async () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const locks = fakeLocks();
    const lock = (nonce: number) => `brainrot-ticket:${ORIGINAL_KEY}:${nonce}`;
    // Another tab holds 12 and 13.
    locks.held.add(lock(12)).add(lock(13));
    vi.stubGlobal('navigator', { locks: { request: locks.request } });
    const claims = await Promise.all([player.claimNonce(), player.claimNonce()]);
    expect(claims.map((c) => c.nonce).sort((a, b) => a - b)).toEqual([14, 15]);
    expect(stored().nextNonce).toBe(16);
    expect(console.error).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(locks.held).toEqual(new Set([lock(12), lock(13), lock(15)])));

    // A lock request that fails: on from the last number tried, past the ones it saw held.
    locks.held.add(lock(16)).add(lock(17));
    const request = vi.fn((name: string, options: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => unknown) =>
      name === lock(18) ? Promise.reject(new DOMException('Timed out', 'AbortError')) : locks.request(name, options, callback));
    vi.stubGlobal('navigator', { locks: { request } });
    expect((await player.claimNonce()).nonce).toBe(18);
    expect(console.error).toHaveBeenCalledWith('Could not hold a ticket number', expect.any(DOMException));
    expect(stored().nextNonce).toBe(19);
  });

  it('moves past a number another tab stored while this one waited for its lock', async () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const locks = fakeLocks((name) => {
      if (name.endsWith(':12')) store.set(PLAYER_KEY, JSON.stringify({ ...original, nextNonce: 15 }));
    });
    vi.stubGlobal('navigator', { locks });
    expect((await player.claimNonce()).nonce).toBe(15);
    expect(stored().nextNonce).toBe(16);
    expect(locks.held).toEqual(new Set([`brainrot-ticket:${ORIGINAL_KEY}:15`]));
  });

  it("takes the new player's number when another tab switches players mid-claim, never mixing the two", async () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const incoming = identity();
    vi.stubGlobal('navigator', { locks: fakeLocks((name) => {
      if (name.includes(ORIGINAL_KEY)) store.set(PLAYER_KEY, JSON.stringify(incoming));
    }) });
    const claim = await player.claimNonce();
    expect(claim.nonce).toBe(7);
    expect(claim.player.publicKeyHex).toBe(toHex(publicKeyFromSecret(fromHex(incoming.secretKey))));
    expect(stored()).toEqual({ ...incoming, nextNonce: 8 });
  });

  it('falls back to this tab alone where Web Locks are missing or refuse', async () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    vi.stubGlobal('navigator', {});
    expect((await player.claimNonce()).nonce).toBe(12);
    vi.stubGlobal('navigator', { locks: { request: vi.fn(async () => { throw new DOMException('Denied', 'SecurityError'); }) } });
    expect((await player.claimNonce()).nonce).toBe(13);
    expect(console.error).toHaveBeenCalledWith('Could not hold a ticket number', expect.any(DOMException));
    vi.stubGlobal('navigator', undefined);
    expect((await player.claimNonce()).nonce).toBe(14);
    expect(stored().nextNonce).toBe(15);
  });

  it('falls back from the last number it tried, never one it saw held by another tab', async () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const locks = fakeLocks();
    locks.held.add(`brainrot-ticket:${ORIGINAL_KEY}:12`).add(`brainrot-ticket:${ORIGINAL_KEY}:13`);
    const request = vi.fn((name: string, options: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => unknown) =>
      name.endsWith(':14') ? Promise.reject(new DOMException('Timed out', 'AbortError')) : locks.request(name, options, callback));
    vi.stubGlobal('navigator', { locks: { request, query: locks.query } });
    expect((await player.claimNonce()).nonce).toBe(14);
    expect(stored().nextNonce).toBe(15);
  });

  it('counts on from the numbers it tried when every lock it asks for is held', async () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const locks = fakeLocks();
    for (let nonce = 12; nonce < 1012; nonce++) locks.held.add(`brainrot-ticket:${ORIGINAL_KEY}:${nonce}`);
    vi.stubGlobal('navigator', { locks });
    expect((await player.claimNonce()).nonce).toBe(1012);
    expect(stored().nextNonce).toBe(1013);
  });

  it('never repeats a number when storage refuses the new count, and says it was not stored', async () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    denyIdentityWrites();
    expect(player.allocateNonce()).toMatchObject({ nonce: 12, stored: false });
    expect(player.allocateNonce()).toMatchObject({ nonce: 13, stored: false });
    vi.stubGlobal('navigator', { locks: fakeLocks() });
    expect(await player.claimNonce()).toMatchObject({ nonce: 14, stored: false });
    expect(player.peekNonce()).toBe(15);
    expect(stored()).toEqual(original);
  });

  it("restores the count when another tab's lower count for the same player lands later, and nothing else", () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const storageEvent = (key: string | null) => target.dispatchEvent(Object.assign(new Event('storage'), { key }));
    store.set(PLAYER_KEY, JSON.stringify(original));
    expect(player.allocateNonce().nonce).toBe(12);
    const changed = vi.fn();
    const stop = player.watchPlayer(changed);

    // Same player, lower count (a rename from a tab that read before this one wrote): keep its name, raise the count.
    store.set(PLAYER_KEY, JSON.stringify({ ...original, name: 'Renamed' }));
    storageEvent(PLAYER_KEY);
    expect(stored()).toEqual({ ...original, name: 'Renamed', nextNonce: 13 });

    // Another player, or a cleared or removed record: left alone.
    store.set(PLAYER_KEY, JSON.stringify(identity()));
    storageEvent(PLAYER_KEY);
    expect(stored()).toEqual(identity());
    store.clear();
    storageEvent(null);
    storageEvent(PLAYER_KEY);
    expect(store.size).toBe(0);
    expect(changed).toHaveBeenCalledTimes(4);

    // Only while watched.
    stop();
    store.set(PLAYER_KEY, JSON.stringify(original));
    storageEvent(PLAYER_KEY);
    expect(stored()).toEqual(original);
  });

  it('says so when storage refuses to restore the count over a lower one, and only then', () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const storageEvent = (key: string | null) => target.dispatchEvent(Object.assign(new Event('storage'), { key }));
    store.set(PLAYER_KEY, JSON.stringify(original));
    expect(player.allocateNonce().nonce).toBe(12);
    const refused = vi.fn();
    const stop = player.watchPlayer(() => undefined, refused);

    store.set(PLAYER_KEY, JSON.stringify(original));
    storageEvent(PLAYER_KEY);
    expect(stored().nextNonce).toBe(13);
    storageEvent(PLAYER_KEY);
    storageEvent(null);
    expect(refused).not.toHaveBeenCalled();

    store.set(PLAYER_KEY, JSON.stringify(original));
    denyIdentityWrites();
    storageEvent(PLAYER_KEY);
    expect(stored()).toEqual(original);
    expect(refused).toHaveBeenCalledTimes(1);
    stop();
  });

  it('keeps the count this tab reached in an export, when storage refused it', () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    denyIdentityWrites();
    expect(player.allocateNonce()).toMatchObject({ nonce: 12, stored: false });
    expect(JSON.parse(player.exportPlayer())).toEqual({ ...original, nextNonce: 13 });
    // What storage holds is still reported as stored, for the history and profile that go with it.
    expect(player.getPlayerTickets().nextNonce).toBe(12);
  });
});
