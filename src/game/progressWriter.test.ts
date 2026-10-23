import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import type { Settings, Stats } from '../types';
import type { CollectionRecoveryState, CollectionSaveResult } from './collectionRecovery';
import type { OpenedPack } from './pulls';
import { createProgressWriter, type HeldProgress, type ProgressWriterHost } from './progressWriter';

// Storage as the writer sees it: every write in order, a pending shelf of nonces, and switches to refuse.
const storage = vi.hoisted(() => ({
  log: [] as string[],
  shelf: new Set<number>(),
  refuse: new Set<string>(),
  shelfFull: false,
  // How many more shelf writes fit before it is full.
  shelfRoom: Infinity,
  collection: 'saved' as CollectionSaveResult,
  // What persistStats does when storage takes the stats ('recovered': it kept unreadable stored stats aside first).
  stats: 'saved' as CollectionSaveResult,
  recovery: 'none' as CollectionRecoveryState,
  history: true,
}));
vi.mock('../utils/storage', () => ({
  setStoredData: (key: string) => {
    storage.log.push(`set ${key}`);
    return !storage.refuse.has(key);
  },
}));
vi.mock('./collectionRecovery', () => ({
  persistCollection: () => {
    storage.log.push('collection');
    return storage.collection;
  },
  collectionRecoveryState: () => storage.recovery,
  collectionRecoveryNote: () => (storage.recovery === 'none' ? undefined : `kept ${storage.recovery}`),
  collectionRecoveryDismissed: () => false,
}));
vi.mock('./statsRecovery', () => ({
  persistStats: () => {
    storage.log.push('set brainrot-stats-v1');
    return storage.refuse.has('brainrot-stats-v1') ? 'blocked' : storage.stats;
  },
}));
vi.mock('./history', () => ({
  recordMissing: (packs: OpenedPack[], key: string) => {
    storage.log.push(`history ${packs.map((p) => p.nonce).join(',')} as ${key}`);
    return storage.history;
  },
}));
vi.mock('./player', () => ({ getPlayer: () => ({ publicKeyHex: 'me' }) }));
vi.mock('./pulls', () => ({
  savePendingPack: (...packs: OpenedPack[]) => {
    storage.log.push(`shelve ${packs.map((p) => `${p.nonce}${p.counted ? '*' : ''}`).join(',')}`);
    if (storage.shelfFull || storage.shelfRoom <= 0) return false;
    storage.shelfRoom -= 1;
    for (const pack of packs) storage.shelf.add(pack.nonce);
    return true;
  },
  clearPendingPack: (...nonces: number[]) => {
    storage.log.push(`unshelve ${nonces.join(',')}`);
    for (const nonce of nonces) storage.shelf.delete(nonce);
  },
  onShelf: (nonce: number) => storage.shelf.has(nonce),
}));

const stats = (packsOpened: number): Stats => ({ packsOpened, holoCards: {}, highestPackValue: 0, highestPackCards: [] });
const loaded: HeldProgress = { collection: {}, achievements: {}, stats: stats(0), hallOfFame: {}, settings: {} as Settings };
const pack = (nonce: number, extra: Partial<OpenedPack> = {}) =>
  ({ setId: 's', setVersion: 1, nonce, cards: [], score: {}, openedAt: 0, ...extra }) as unknown as OpenedPack;
/** A pack added: a new collection and stats object, as App's state holds after one. */
const withPack = (from: HeldProgress): HeldProgress =>
  ({ ...from, collection: { ...from.collection }, stats: stats(from.stats.packsOpened + 1) });

// The stored-packs record (ProgressGuard.storing and friends): its calls apart from the rest, whether it
// can be written, and which nonces another tab's collection dropped.
let host: ProgressWriterHost & { calls: string[]; player: boolean; current: boolean; stamps: string[]; stampable: boolean; drop: number[] };
const writer = () => createProgressWriter(host);
beforeEach(() => {
  Object.assign(storage, { log: [], shelf: new Set(), refuse: new Set(), shelfFull: false, shelfRoom: Infinity, collection: 'saved', stats: 'saved', recovery: 'none', history: true });
  const calls: string[] = [];
  const stamps: string[] = [];
  host = {
    calls, player: true, current: true, stamps, stampable: true, drop: [],
    samePlayer: () => host.player,
    progressCurrent: () => host.current,
    noted: () => calls.push('noted'),
    stale: () => calls.push('stale'),
    failed: () => calls.push('failed'),
    keptAside: (note, dismissed) => calls.push(`keptAside ${note} ${dismissed}`),
    storing: (player, nonces) => {
      stamps.push(`storing ${nonces.join(',')} as ${player}`);
      return host.stampable;
    },
    unstored: () => stamps.push('unstored'),
    dropped: (player, nonces) => {
      stamps.push(`dropped? ${nonces.join(',')} as ${player}`);
      return nonces.filter((nonce) => host.drop.includes(nonce));
    },
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('createProgressWriter', () => {
  it('writes nothing, and asks nothing, for the progress the tab loaded', () => {
    const w = writer();
    w.commit(loaded);
    expect(storage.log).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  it('stores only what changed: the collection first, then achievements, stats, Hall of Fame and settings', () => {
    const w = writer();
    w.commit(loaded);
    const next = { ...withPack(loaded), achievements: { a: 1 }, hallOfFame: { h: {} } as HeldProgress['hallOfFame'], settings: { s: 1 } as unknown as Settings };
    w.commit(next);
    expect(storage.log).toEqual([
      'collection', `set ${STORAGE_KEYS.ACHIEVEMENTS}`, `set ${STORAGE_KEYS.STATS}`, `set ${STORAGE_KEYS.HALL_OF_FAME}`, `set ${STORAGE_KEYS.SETTINGS}`,
    ]);
    expect(host.calls).toEqual(['noted']);

    storage.log.length = 0;
    const settled = { ...next, settings: { s: 2 } as unknown as Settings };
    w.commit(settled);
    expect(storage.log).toEqual([`set ${STORAGE_KEYS.SETTINGS}`]);
    // Unchanged progress writes nothing but still notes it holds what storage has.
    storage.log.length = 0;
    w.commit({ ...settled });
    expect(storage.log).toEqual([]);
    expect(host.calls).toEqual(['noted', 'noted', 'noted']);
  });

  it('writes nothing for another player, and leaves the packs it owes on the shelf as they are', () => {
    const w = writer();
    w.commit(loaded);
    w.packsTaken([pack(1)]);
    w.packAdded(pack(1));
    host.player = false;
    w.commit(withPack(loaded));
    expect(storage.log).toEqual([]);
    expect(host.calls).toEqual(['stale']);
    // Nor does a put-back (the shelf holds another save's packs now).
    w.putBack();
    expect(storage.log).toEqual([]);
  });

  it('writes nothing once another tab of this player stored progress, and puts back only the packs it took at load', () => {
    const w = writer();
    w.commit(loaded);
    w.packsTaken([pack(1), pack(2, { legacy: true })]);
    w.packAdded(pack(1));
    w.packAdded(pack(2, { legacy: true }));
    w.packAdded(pack(3));
    host.current = false;
    w.commit(withPack(loaded));
    // Pack 3 opened here went on the shelf when it opened; the older build's pack 2 stays in its own entry.
    expect(storage.log).toEqual(['shelve 1']);
    expect(host.calls).toEqual(['stale']);
    // Back on the shelf, it is the next load's: no second put-back.
    w.putBack();
    expect(storage.log).toEqual(['shelve 1']);
  });

  it('keeps a pack it took at load owed, and warns, while the shelf refuses it', () => {
    const w = writer();
    w.commit(loaded);
    w.packsTaken([pack(1)]);
    storage.shelfFull = true;
    w.putBack();
    expect(host.calls).toEqual(['failed']);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("1 pack(s) couldn't be put back on the pending shelf"));
    storage.shelfFull = false;
    w.putBack();
    expect(storage.log).toEqual(['shelve 1', 'shelve 1']);
    expect(host.calls).toEqual(['failed']);
  });

  it('clears the shelf of the packs a stored collection holds, then records their ticket mappings', () => {
    const w = writer();
    w.commit(loaded);
    w.packsTaken([pack(1)]);
    w.packAdded(pack(1));
    w.packAdded(pack(2));
    storage.shelf = new Set([2]);
    w.commit(withPack(loaded));
    expect(storage.log).toEqual(['collection', 'unshelve 1,2', 'history 1,2 as me', `set ${STORAGE_KEYS.STATS}`]);
    expect(host.calls).toEqual(['noted']);
    // Nothing is owed any more.
    host.current = false;
    storage.log.length = 0;
    w.commit(withPack(withPack(loaded)));
    expect(storage.log).toEqual([]);
  });

  it('warns when the history still refuses a ticket mapping once its pack is stored', () => {
    const w = writer();
    w.commit(loaded);
    w.packAdded(pack(1));
    storage.history = false;
    w.commit(withPack(loaded));
    expect(host.calls).toEqual(['failed', 'noted']);
  });

  it('shelves the packs a full collection refused marked as counted, with the stats counting them, and keeps the rest', () => {
    const w = writer();
    w.commit(loaded);
    w.packsTaken([pack(1)]);
    w.packAdded(pack(1));
    storage.collection = 'blocked';
    const next = { ...withPack(loaded), achievements: { a: 1 } };
    w.commit(next);
    // Stats are written once, right after the marked copies; the other fields follow as usual.
    expect(storage.log).toEqual(['collection', 'shelve 1*', `set ${STORAGE_KEYS.STATS}`, 'history 1 as me', `set ${STORAGE_KEYS.ACHIEVEMENTS}`]);
    expect(host.calls).toEqual(['failed', 'noted']);
    // The marked copy is owed now: the next try stores it (or shelves it) as counted.
    storage.log.length = 0;
    w.commit(withPack(next));
    expect(storage.log).toEqual(['collection', 'shelve 1*', `set ${STORAGE_KEYS.STATS}`, 'history 1 as me']);
    // Back on the shelf, the pack taken at load is the next load's: no put-back.
    host.current = false;
    storage.log.length = 0;
    w.commit(withPack(withPack(next)));
    expect(storage.log).toEqual([]);
  });

  it('puts the packs back uncounted when the stats counting them are refused', () => {
    const w = writer();
    w.commit(loaded);
    w.packAdded(pack(1));
    storage.collection = 'blocked';
    storage.refuse.add(STORAGE_KEYS.STATS);
    w.commit(withPack(loaded));
    expect(storage.log).toEqual(['collection', 'shelve 1*', `set ${STORAGE_KEYS.STATS}`, 'shelve 1', 'history 1 as me']);
    expect(host.calls).toEqual(['failed', 'noted']);
    expect(console.error).not.toHaveBeenCalled();
    // Still owed unmarked, so the next try marks it again.
    storage.refuse.clear();
    storage.log.length = 0;
    w.commit(withPack(withPack(loaded)));
    expect(storage.log[1]).toBe('shelve 1*');
  });

  it('warns that only this tab has the packs when the shelf refuses both copies', () => {
    const w = writer();
    w.commit(loaded);
    w.packAdded(pack(1));
    storage.collection = 'blocked';
    storage.refuse.add(STORAGE_KEYS.STATS);
    w.commit(withPack(loaded));
    expect(console.error).not.toHaveBeenCalled();
    storage.shelfFull = true;
    w.commit(withPack(withPack(loaded)));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("1 pack(s) couldn't be put back on the pending shelf"));
  });

  it('says the shelf holds a counted copy when the stats counting it, then the uncounted copy, are refused', () => {
    const w = writer();
    w.commit(loaded);
    w.packsTaken([pack(1)]);
    w.packAdded(pack(1));
    storage.collection = 'blocked';
    storage.refuse.add(STORAGE_KEYS.STATS);
    // The marked copy fits, the stats don't, and then the shelf is full.
    storage.shelfRoom = 1;
    w.commit(withPack(loaded));
    expect(storage.log).toEqual(['collection', 'shelve 1*', `set ${STORAGE_KEYS.STATS}`, 'shelve 1', 'history 1 as me']);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('1 pack(s) are on the pending shelf marked as counted'));
    // The marked copy is on the shelf, so the pack taken at load is the next load's: no put-back.
    host.current = false;
    storage.log.length = 0;
    w.commit(withPack(withPack(loaded)));
    expect(storage.log).toEqual([]);
  });

  it('shows the kept-aside note when the collection write archived unreadable entries, or could not run', () => {
    const w = writer();
    w.commit(loaded);
    storage.collection = 'recovered';
    storage.recovery = 'stored';
    w.commit(withPack(loaded));
    storage.collection = 'blocked';
    storage.recovery = 'unsaved';
    w.commit(withPack(withPack(loaded)));
    storage.collection = 'saved';
    w.commit(withPack(withPack(withPack(loaded))));
    expect(host.calls).toEqual(['keptAside kept stored false', 'noted', 'failed', 'keptAside kept unsaved false', 'noted', 'noted']);
  });

  it('shows the kept-aside note when the stats write kept unreadable stored stats aside, once', () => {
    const w = writer();
    w.commit(loaded);
    storage.stats = 'recovered';
    storage.recovery = 'stored';
    w.commit({ ...loaded, stats: stats(1) });
    storage.stats = 'saved';
    w.commit({ ...loaded, stats: stats(2) });
    expect(storage.log).toEqual([`set ${STORAGE_KEYS.STATS}`, `set ${STORAGE_KEYS.STATS}`]);
    expect(host.calls).toEqual(['keptAside kept stored false', 'noted', 'noted']);
  });

  it('keeps unreadable stored stats aside before the stats counting shelved packs replace them', () => {
    const w = writer();
    w.commit(loaded);
    w.packAdded(pack(1));
    storage.collection = 'blocked';
    storage.stats = 'recovered';
    storage.recovery = 'stored';
    w.commit(withPack(loaded));
    expect(storage.log).toEqual(['collection', 'shelve 1*', `set ${STORAGE_KEYS.STATS}`, 'history 1 as me']);
    expect(host.calls).toEqual(['failed', 'keptAside kept stored false', 'noted']);
  });

  it('raises and replaces no kept-aside note while storage refuses to read the archive', () => {
    const w = writer();
    w.commit(loaded);
    storage.collection = 'blocked';
    storage.recovery = 'unavailable';
    w.commit(withPack(loaded));
    expect(host.calls).toEqual(['failed', 'noted']);
  });

  it('warns for each field storage refuses, still tries the rest, and still notes what it holds', () => {
    const w = writer();
    w.commit(loaded);
    storage.refuse.add(STORAGE_KEYS.ACHIEVEMENTS);
    w.commit({ ...loaded, achievements: { a: 1 }, hallOfFame: { h: {} } as HeldProgress['hallOfFame'] });
    expect(storage.log).toEqual([`set ${STORAGE_KEYS.ACHIEVEMENTS}`, `set ${STORAGE_KEYS.HALL_OF_FAME}`]);
    expect(host.calls).toEqual(['failed', 'noted']);
  });

  it('records the packs a collection write holds just before it, and puts the record back when the write is blocked', () => {
    const w = writer();
    w.commit(loaded);
    w.commit(withPack(loaded));
    // No packs: nothing to record.
    expect(host.stamps).toEqual([]);
    w.packAdded(pack(1));
    w.packAdded(pack(2));
    w.commit(withPack(withPack(loaded)));
    expect(host.stamps).toEqual(['storing 1,2 as me']);

    host.stamps.length = 0;
    storage.collection = 'blocked';
    w.packAdded(pack(3));
    w.commit(withPack(withPack(withPack(loaded))));
    expect(host.stamps).toEqual(['storing 3 as me', 'unstored']);
    // Nor when the record itself can't be written.
    host.stamps.length = 0;
    host.stampable = false;
    w.commit(withPack(withPack(withPack(withPack(loaded)))));
    expect(host.stamps).toEqual(['storing 3 as me']);
  });

  it('once stale, puts back the packs it stored that another tab\'s collection dropped, and only those', () => {
    const w = writer();
    w.commit(loaded);
    // 3 came off the shelf counted at load; 2 is this tab's own, marked counted by a refused write.
    w.packsTaken([pack(3, { counted: true })]);
    w.packAdded(pack(3, { counted: true }));
    w.packAdded(pack(1));
    w.packAdded(pack(2, { counted: true }));
    w.commit(withPack(loaded));
    storage.log.length = 0;
    host.drop = [2, 3];
    host.current = false;
    w.commit(withPack(withPack(loaded)));
    expect(host.stamps).toEqual(['storing 3,1,2 as me', 'dropped? 3,1,2 as me']);
    // Its own goes back uncounted (the other tab's stats never counted it); the taken one stays counted
    // (the stats both tabs loaded count it).
    expect(storage.log).toEqual(['shelve 3*,2']);
    expect(host.calls).toEqual(['noted', 'stale']);
    // Back on the shelf, it is the next load's: no second put-back.
    w.putBack();
    expect(storage.log).toEqual(['shelve 3*,2']);
  });

  it('keeps a dropped pack owed, and warns, while the shelf refuses it', () => {
    const w = writer();
    w.commit(loaded);
    w.packAdded(pack(1));
    w.commit(withPack(loaded));
    host.drop = [1];
    storage.shelfFull = true;
    w.putBack();
    expect(host.calls).toEqual(['noted', 'failed']);
    storage.shelfFull = false;
    w.putBack();
    expect(storage.log.filter((line) => line.startsWith('shelve'))).toEqual(['shelve 1', 'shelve 1']);
  });

  it('puts back nothing it stored when the record is another tab\'s and holds them, or after a player switch', () => {
    const w = writer();
    w.commit(loaded);
    w.packAdded(pack(1));
    w.commit(withPack(loaded));
    storage.log.length = 0;
    w.putBack();
    expect(storage.log).toEqual([]);
    host.drop = [1];
    host.player = false;
    w.putBack();
    expect(storage.log).toEqual([]);
  });
});
