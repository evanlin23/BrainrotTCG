import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { fromHex, isNameAllowed, publicKeyFromSecret, toHex } from '../engine';

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

  it('keeps this browser\'s allowed name when the same key comes back with a blocked one', () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    expect(player.importPlayer(JSON.stringify(identity(original.secretKey, 3, 'xXfuckXx')))).toBe(true);
    expect(JSON.parse(store.get(PLAYER_KEY)!)).toEqual({ ...original, nextNonce: 12 });
  });

  it('gives a different key with a blocked name a random name, never this browser\'s', () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const incoming = identity(undefined, 7, 'f u c k');
    expect(player.importPlayer(JSON.stringify(incoming))).toBe(true);
    const stored = JSON.parse(store.get(PLAYER_KEY)!) as typeof incoming;
    expect({ ...stored, name: '' }).toEqual({ ...incoming, name: '' });
    expect(stored.name).not.toBe(original.name);
    expect(stored.name).toMatch(/^\w+ \w+ \d\d$/);
  });

  it('only rewrites a moved-in record whose name is blocked', () => {
    const fine = JSON.stringify(identity());
    expect(player.withAllowedName(fine)).toBe(fine);
    expect(player.withAllowedName('not json')).toBe('not json');
    const moved = JSON.parse(player.withAllowedName(JSON.stringify(identity(undefined, 7, 'B1gD1ck')))) as ReturnType<typeof identity>;
    expect(moved.secretKey).toBe(identity().secretKey);
    expect(moved.nextNonce).toBe(7);
    expect(moved.name).toMatch(/^\w+ \w+ \d\d$/);
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

  it.each(['xXfuckXx', 'N.I.G.G.E.R', 'Ｐｏｒｎ'])('refuses a blocked name (%s), writing nothing and keeping the current one', (name) => {
    const result = player.renamePlayer(name, ORIGINAL_KEY);
    expect(result.status).toBe('blocked');
    expect(nameOf(result)).toBe('Original Player');
    expect(setItem).not.toHaveBeenCalled();
    expect(player.getPlayer().name).toBe('Original Player');
  });

  it('never picks a blocked random name', () => {
    const names = player.ADJECTIVES.flatMap((adjective) => player.NOUNS.map((noun) => `${adjective} ${noun} 10`));
    expect(names.filter((name) => !isNameAllowed(name))).toEqual([]);
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
    /** Requests waiting for a name to be let go of, woken in the order they asked. */
    const waiting = new Map<string, (() => void)[]>();
    const request = vi.fn(async (name: string, options: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => unknown) => {
      await Promise.resolve();
      while (held.has(name) && !options.ifAvailable) await new Promise<void>((wake) => waiting.set(name, [...(waiting.get(name) ?? []), wake]));
      if (held.has(name)) return callback(null);
      held.add(name);
      beforeGrant?.(name);
      try {
        return await callback({ name });
      } finally {
        held.delete(name);
        // A browser grants the next request in a task of its own, after the holder's promise has settled.
        const next = waiting.get(name);
        waiting.delete(name);
        if (next) setTimeout(() => next.forEach((wake) => wake()), 0);
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
    // The first tab's query() answers only once the other tab's claim has asked for its turn, so the two overlap.
    let requests = 0;
    let secondTabAsked: () => void = () => {};
    const bothAsked = new Promise<void>((resolve) => { secondTabAsked = resolve; });
    const request = vi.fn((...args: Parameters<typeof locks.request>) => {
      if (++requests === 2) secondTabAsked();
      return locks.request(...args);
    });
    const query = vi.fn(async () => { await bothAsked; return locks.query(); });
    vi.stubGlobal('navigator', { locks: { request, query } });
    vi.resetModules();
    const tabA = await import('./player');
    vi.resetModules();
    const tabB = await import('./player');
    const claims = await Promise.all([tabA.claimNonce(), tabB.claimNonce()]);
    expect(claims.map((c) => c.nonce).sort((a, b) => a - b)).toEqual([12, 13]);
    expect(stored().nextNonce).toBe(14);
  });

  it('still takes turns where Web Locks lack query(), past numbers other tabs still hold, falling back from the last number tried', async () => {
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

  it("counts on alone when the key's lock stays held past its wait, as a hung tab would hold it", async () => {
    vi.useFakeTimers();
    try {
      store.set(PLAYER_KEY, JSON.stringify(original));
      const locks = fakeLocks();
      // Another tab holds the key's lock and never lets go: the request waits until its signal aborts it.
      const request = vi.fn((name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: { name: string } | null) => unknown) =>
        name === `brainrot-ticket:${ORIGINAL_KEY}`
          ? new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
          : locks.request(name, options, callback));
      vi.stubGlobal('navigator', { locks: { request, query: locks.query } });
      let settled = false;
      const claim = player.claimNonce().finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await claim).toMatchObject({ nonce: 12, stored: true });
      expect(stored().nextNonce).toBe(13);
      // Logged only: opening goes on, with no error shown.
      expect(console.error).toHaveBeenCalledWith('Could not hold a ticket number', expect.any(DOMException));
    } finally {
      vi.useRealTimers();
    }
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

  it("refuses to claim the new player's number when authorized for an initiating save that was replaced mid-claim", async () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const initiating = player.saveMark();
    const incoming = identity();
    vi.stubGlobal('navigator', { locks: fakeLocks((name) => {
      if (name.includes(ORIGINAL_KEY)) store.set(PLAYER_KEY, JSON.stringify(incoming));
    }) });
    await expect(player.claimNonce(initiating)).rejects.toBeInstanceOf(player.StaleSaveError);
    // Incoming player's counter was not touched.
    expect(stored()).toEqual(incoming);
  });

  it("refuses to claim when the save is replaced by a new import stamp of the same player mid-claim", async () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const initiating = player.saveMark();
    vi.stubGlobal('navigator', { locks: fakeLocks((name) => {
      if (name.includes(ORIGINAL_KEY)) store.set(player.SAVE_STAMP_KEY, player.newSaveStamp());
    }) });
    await expect(player.claimNonce(initiating)).rejects.toBeInstanceOf(player.StaleSaveError);
    expect(stored()).toEqual(original);
  });

  it("refuses to restart a claim on the new player's counter when the save is replaced after a turn found its number taken", async () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const initiating = player.saveMark();
    const incoming = identity();
    const locks = fakeLocks();
    const lock = (nonce: number) => `brainrot-ticket:${ORIGINAL_KEY}:${nonce}`;
    // Another tab of the same player holds 12, so this turn is turned away and the claim would try again.
    locks.held.add(lock(12));
    const request = vi.fn(async (name: string, options: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => unknown) => {
      const result = await locks.request(name, options, callback);
      if (name === lock(12)) store.set(PLAYER_KEY, JSON.stringify(incoming));
      return result;
    });
    vi.stubGlobal('navigator', { locks: { request } });
    await expect(player.claimNonce(initiating)).rejects.toBeInstanceOf(player.StaleSaveError);
    expect(request).toHaveBeenCalledWith(lock(12), expect.anything(), expect.any(Function));
    expect(request.mock.calls.map(([name]) => name).some((name) => !name.includes(ORIGINAL_KEY))).toBe(false);
    expect(stored()).toEqual(incoming);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("refuses fallback claiming when the save changed during lock wait or lock failure", async () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const initiating = player.saveMark();
    const incoming = identity();
    vi.stubGlobal('navigator', { locks: { request: vi.fn(async () => {
      store.set(PLAYER_KEY, JSON.stringify(incoming));
      throw new DOMException('Denied', 'SecurityError');
    }) } });
    await expect(player.claimNonce(initiating)).rejects.toBeInstanceOf(player.StaleSaveError);
    expect(stored()).toEqual(incoming);
  });

  it("refuses allocateNonce when the save changed", () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    const initiating = player.saveMark();
    const incoming = identity();
    store.set(PLAYER_KEY, JSON.stringify(incoming));
    expect(() => player.allocateNonce(initiating)).toThrow(player.StaleSaveError);
    expect(stored()).toEqual(incoming);
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

  it('watchStoredPlayer hears the same storage events as watchPlayer but never writes the count back', () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const storageEvent = (key: string | null) => target.dispatchEvent(Object.assign(new Event('storage'), { key }));
    store.set(PLAYER_KEY, JSON.stringify(original));
    expect(player.allocateNonce().nonce).toBe(12);
    const changed = vi.fn();
    const stop = player.watchStoredPlayer(changed);

    // A lower count from another tab: watchPlayer would store 13 again, this leaves it alone.
    store.set(PLAYER_KEY, JSON.stringify({ ...original, name: 'Renamed' }));
    storageEvent(PLAYER_KEY);
    expect(stored()).toEqual({ ...original, name: 'Renamed' });
    storageEvent(player.SAVE_STAMP_KEY);
    storageEvent(null);
    storageEvent('unrelated');
    expect(changed).toHaveBeenCalledTimes(3);

    stop();
    storageEvent(PLAYER_KEY);
    expect(changed).toHaveBeenCalledTimes(3);
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

  it.each([['with Web Locks', true], ['without them', false]])(
    'counts past every ticket the pack history records for this key, when storage refused the counter past them (%s)',
    async (_label, withLocks) => {
      vi.stubGlobal('navigator', withLocks ? { locks: fakeLocks() } : {});
      const mapping = (key: string, n: number) => ({ s: 'right-now', v: 2, n, k: key.slice(0, 16), h: 'High Card', x: 1, t: n });
      // Tickets 12 and 13 were opened and recorded, but the counter past them never landed; 40 is another key's.
      store.set(PLAYER_KEY, JSON.stringify(original));
      store.set(STORAGE_KEYS.HISTORY, JSON.stringify([mapping('cc'.repeat(32), 40), mapping(ORIGINAL_KEY, 13), mapping(ORIGINAL_KEY, 12), { n: 99 }]));
      expect(player.peekNonce()).toBe(14);
      expect(player.getPlayerTickets()).toMatchObject({ player: { publicKeyHex: ORIGINAL_KEY }, nextNonce: 14 });
      expect(JSON.parse(player.exportPlayer())).toEqual({ ...original, nextNonce: 14 });
      expect(await player.claimNonce()).toMatchObject({ nonce: 14, stored: true });
      expect(stored()).toEqual({ ...original, nextNonce: 15 });
    },
  );

  it('keeps the stored counter when the history records nothing past it, or cannot be read', () => {
    store.set(PLAYER_KEY, JSON.stringify(original));
    store.set(STORAGE_KEYS.HISTORY, '{not json');
    expect(player.peekNonce()).toBe(12);
    store.set(STORAGE_KEYS.HISTORY, JSON.stringify([{ s: 'right-now', v: 2, n: 3, k: ORIGINAL_KEY.slice(0, 16), h: 'High Card', x: 1, t: 1 }]));
    expect(player.allocateNonce().nonce).toBe(12);
    expect(stored().nextNonce).toBe(13);
  });

  it.each([['with Web Locks', true], ['without them', false]])(
    'refuses a number with no safe successor before writing anything, rather than store a count a read would reject (%s)',
    async (_label, withLocks) => {
      vi.stubGlobal('navigator', withLocks ? { locks: fakeLocks() } : {});
      const last = Number.MAX_SAFE_INTEGER - 1;
      store.set(PLAYER_KEY, JSON.stringify({ ...original, nextNonce: last }));
      expect(await player.claimNonce()).toMatchObject({ nonce: last, stored: true });
      expect(stored().nextNonce).toBe(Number.MAX_SAFE_INTEGER);
      setItem.mockClear();
      await expect(player.claimNonce()).rejects.toThrow(RangeError);
      expect(setItem).not.toHaveBeenCalled();
      expect(player.getPlayer().publicKeyHex).toBe(ORIGINAL_KEY);
      // Logged as the counter running out, not as a lock that failed.
      if (withLocks) expect(console.error).toHaveBeenCalledWith(player.COUNTER_EXHAUSTED, expect.any(RangeError));
      expect(console.error).not.toHaveBeenCalledWith('Could not hold a ticket number', expect.anything());

      // A corrupt mapping that high in the history: the same, with the stored record untouched.
      store.set(PLAYER_KEY, JSON.stringify(original));
      store.set(STORAGE_KEYS.HISTORY, JSON.stringify([{ s: 'right-now', v: 2, n: last, k: ORIGINAL_KEY.slice(0, 16), h: 'High Card', x: 1, t: 1 }]));
      vi.resetModules();
      const fresh = await import('./player');
      expect(fresh.peekNonce()).toBe(Number.MAX_SAFE_INTEGER);
      setItem.mockClear();
      await expect(fresh.claimNonce()).rejects.toThrow(RangeError);
      expect(setItem).not.toHaveBeenCalled();
      expect(stored()).toEqual(original);
    },
  );

  it('ignores a mapping or a held lock with no safe successor', async () => {
    const locks = fakeLocks();
    locks.held.add(`brainrot-ticket:${ORIGINAL_KEY}:${Number.MAX_SAFE_INTEGER}`);
    vi.stubGlobal('navigator', { locks });
    store.set(PLAYER_KEY, JSON.stringify(original));
    store.set(STORAGE_KEYS.HISTORY, JSON.stringify([{ s: 'right-now', v: 2, n: Number.MAX_SAFE_INTEGER, k: ORIGINAL_KEY.slice(0, 16), h: 'High Card', x: 1, t: 1 }]));
    expect(player.peekNonce()).toBe(12);
    expect((await player.claimNonce()).nonce).toBe(12);
  });

  it("reads the history once per change, and sees another tab's write at once", () => {
    const parse = vi.spyOn(JSON, 'parse');
    const mapping = (n: number) => ({ s: 'right-now', v: 2, n, k: ORIGINAL_KEY.slice(0, 16), h: 'High Card', x: 1, t: n });
    store.set(PLAYER_KEY, JSON.stringify(original));
    store.set(STORAGE_KEYS.HISTORY, JSON.stringify([mapping(20)]));
    const historyParses = () => parse.mock.calls.filter(([raw]) => raw === store.get(STORAGE_KEYS.HISTORY)).length;
    for (let i = 0; i < 3; i++) expect(player.peekNonce()).toBe(21);
    expect(historyParses()).toBe(1);
    // Another tab records a later ticket: the next read counts it, with no storage event needed.
    store.set(STORAGE_KEYS.HISTORY, JSON.stringify([mapping(30), mapping(20)]));
    expect(player.peekNonce()).toBe(31);
    expect(player.peekNonce()).toBe(31);
    expect(historyParses()).toBe(1);
  });

  it("counts a stored record's tickets past the ones its history records, as claims do", () => {
    expect(player.ticketCount(JSON.stringify(original))).toBe(12);
    store.set(STORAGE_KEYS.HISTORY, JSON.stringify([{ s: 'right-now', v: 2, n: 13, k: ORIGINAL_KEY.slice(0, 16), h: 'High Card', x: 1, t: 1 }]));
    expect(player.ticketCount(JSON.stringify(original))).toBe(14);
    expect(player.ticketCount(JSON.stringify({ ...original, nextNonce: 20 }))).toBe(20);
    expect(player.ticketCount('{not json')).toBeNull();
  });
});
