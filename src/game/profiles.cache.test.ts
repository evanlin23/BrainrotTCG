import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { computeTicket, derivePack, profileStats, scorePulled, setKey, type ProfilePack, type SetDefinition } from '../engine';
import { encodeCard } from './cardCode';
import { getStoredPack, hydratePackStore, packRefKey, putStoredPacks, resetPackStore, type StoredPack, type StoredPackRef } from './packStore';
import { getPlayer } from './player';
import { myProfileInfo, myProgress, myStats } from './profiles';
import { resetTicketList } from './myTickets';
import { historyAchievementsReady, historyPacksState, hydrateMyPacks, myPackCacheState, watchMyPacks } from './packCache';
import { reopenStatus, resumeReopening } from './reopenJob';

// Saved packs are read through hydratePackStore alone. Here it stands in for IndexedDB, and each read
// waits for the test to finish or fail it. packStore.test.ts covers the pages, aborts and owner
// checks underneath, so this file is about what profiles show while a read runs.
vi.mock('./packStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./packStore')>()),
  hydratePackStore: vi.fn(),
}));

const data = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, v),
  removeItem: (k: string) => void data.delete(k),
});
vi.stubGlobal('window', new EventTarget());

const RIGHT_NOW = getSet('right-now', 2)!;
const RIGHT_NOW_V1 = getSet('right-now', 1)!;
const GENESIS = getSet('genesis', 1)!;
const PENDING = 'brainrot-reopen-pending-v1';

interface Read {
  refs: StoredPackRef[];
  signal?: AbortSignal;
  keep: () => boolean;
  finish: () => Promise<void>;
  fail: (error: Error) => void;
}
let reads: Read[] = [];
/** What this device's IndexedDB holds. */
let saved = new Map<string, StoredPack>();
const idOf = (p: StoredPackRef) => packRefKey(p.setKey, p.publicKeyHex, p.nonce);

beforeEach(() => {
  reads = [];
  vi.mocked(hydratePackStore).mockImplementation((refs, signal, keep = () => true) => new Promise<boolean>((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    reads.push({
      refs: [...refs],
      signal,
      keep,
      // Like the real one: a read that lands after its owner was retired is dropped.
      finish: async () => {
        const kept = keep();
        if (kept) await putStoredPacks(refs.flatMap((r) => saved.get(idOf(r)) ?? []));
        resolve(kept);
      },
      fail: reject,
    });
  }));
});

afterEach(async () => {
  // Settle anything left open, so the next test's read isn't queued behind it.
  for (const read of reads) await read.finish();
  vi.restoreAllMocks();
});

let players = 0;
const storePlayer = (secretKey: string, nextNonce: number) =>
  data.set('brainrot-player-v1', JSON.stringify({ secretKey, name: 'Tester', nextNonce, createdAt: 0 }));

/** A new player (so no earlier test's read counts for them) whose tickets' cards the history dropped. */
const setUp = (sets: SetDefinition[]) => {
  data.clear();
  resetPackStore();
  saved = new Map();
  storePlayer((++players).toString(16).padStart(2, '0').repeat(32), sets.length);
  const key = getPlayer().publicKeyHex.slice(0, 16);
  const history = sets.map((set, n) => ({ s: set.id, v: set.version, n, k: key, h: 'No Matches', x: 0, t: n + 1 }));
  data.set(STORAGE_KEYS.HISTORY, JSON.stringify(history));
  return getPlayer();
};

/** Re-open a pack the way the app does and keep it in "IndexedDB" only. */
const savePack = async (set: SetDefinition, nonce: number): Promise<ProfilePack> => {
  const player = getPlayer();
  const cards = await derivePack(set, player.publicKey, nonce, computeTicket);
  const code = cards.map((c) => encodeCard({ id: c.cardId, holo: c.isHolo, finish: c.finish, misprint: c.misprint })).join(',');
  const pack = { setKey: setKey(set), publicKeyHex: player.publicKeyHex, nonce, cards: code };
  saved.set(idOf(pack), pack);
  return { nonce, set, cards, score: scorePulled(cards) };
};

describe('saved packs read on demand', () => {
  it('shows saved progress as loading, never zero, until your packs are read; then the stats a full load gave', async () => {
    const player = setUp([GENESIS, RIGHT_NOW, RIGHT_NOW, RIGHT_NOW]);
    // Ticket 2 was never re-opened on this device, so it stays missing once the read is done.
    const packs = [await savePack(GENESIS, 0), await savePack(RIGHT_NOW, 1), await savePack(RIGHT_NOW, 3)];

    const run = hydrateMyPacks();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    expect(reads[0].refs).toEqual([0, 1, 2, 3].map((nonce) => ({
      setKey: nonce ? 'right-now@2' : 'genesis@1', publicKeyHex: player.publicKeyHex, nonce,
    })));
    expect(myPackCacheState()).toBe('loading');
    expect(myStats()).toBeNull();
    expect(myProgress()).toBeNull();
    expect(myProfileInfo()).toMatchObject({ packs: 4, missing: 4, cache: 'loading' });

    await reads[0].finish();
    expect(await run).toBe('ready');
    expect(myPackCacheState()).toBe('ready');
    // The streamed stats are what profileStats gave over every pack loaded at once.
    expect(myStats()).toEqual(profileStats(packs));
    expect(myProgress()).toMatchObject({ level: myStats()!.level, xp: myStats()!.xp });
    expect(myProfileInfo()).toMatchObject({ packs: 4, missing: 1, cache: 'ready' });
  }, 30_000);

  it('shows a failed first read as failed (not zero), and keeps what it showed when a later read fails', async () => {
    setUp([RIGHT_NOW, RIGHT_NOW]);
    await savePack(RIGHT_NOW, 0);
    const history = data.get(STORAGE_KEYS.HISTORY);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const first = hydrateMyPacks();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    reads[0].fail(new Error('disk'));
    expect(await first).toBe('failed');
    expect(myPackCacheState()).toBe('failed');
    expect(myStats()).toBeNull();
    expect(myProgress()).toBeNull();
    expect(myProfileInfo()).toMatchObject({ missing: 2, cache: 'failed' });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(data.get(STORAGE_KEYS.HISTORY)).toBe(history); // A failed read writes nothing.

    const retry = hydrateMyPacks();
    expect(myPackCacheState()).toBe('loading');
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    await reads[1].finish();
    expect(await retry).toBe('ready');
    expect(myStats()?.packs).toBe(1);

    // Read again (another tab wrote): the packs already read stay shown, during and after a failure.
    const again = hydrateMyPacks();
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    expect(myPackCacheState()).toBe('ready');
    expect(myStats()?.packs).toBe(1);
    reads[2].fail(new Error('disk'));
    expect(await again).toBe('ready');
    expect(myPackCacheState()).toBe('ready');
    expect(myStats()?.packs).toBe(1);
    expect(myProfileInfo()).toMatchObject({ missing: 1, cache: 'ready' });
    // Your own unread pack still holds back the history's achievements.
    expect(historyPacksState()).toBe('failed');
    expect(historyAchievementsReady()).toBe(false);
  }, 30_000);

  it("drops a read whose player changed mid-read, and reads the new player's packs instead", async () => {
    const before = setUp([RIGHT_NOW]);
    await savePack(RIGHT_NOW, 0);
    const run = hydrateMyPacks();
    await vi.waitFor(() => expect(reads).toHaveLength(1));

    // Another tab imports a different save while the read is going.
    storePlayer('fe'.repeat(32), 1);
    const after = getPlayer();
    const history = JSON.parse(data.get(STORAGE_KEYS.HISTORY)!);
    history.push({ ...history[0], k: after.publicKeyHex.slice(0, 16), t: 9 });
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify(history));

    expect(reads[0].keep()).toBe(false);
    await reads[0].finish();
    expect(await run).toBe('loading');
    expect(getStoredPack('right-now@2', before.publicKeyHex, 0)).toBeUndefined();
    // The old player's read never counts as the new player's: still loading, not ready and not zero.
    expect(myPackCacheState()).toBe('loading');
    expect(myStats()).toBeNull();
    expect(myProfileInfo()).toMatchObject({ packs: 1, cache: 'loading' });

    const next = hydrateMyPacks();
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    expect(reads[1].refs).toEqual([{ setKey: 'right-now@2', publicKeyHex: after.publicKeyHex, nonce: 0 }]);
    await reads[1].finish();
    // Your own stats show as soon as your packs are in; the old player's pack is read after them.
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    expect(reads[2].refs).toEqual([{ setKey: 'right-now@2', publicKeyHex: before.publicKeyHex.slice(0, 16), nonce: 0 }]);
    expect(myPackCacheState()).toBe('ready');
    expect(myStats()).toMatchObject({ packs: 0 });
    expect(historyPacksState()).toBe('loading');
    await reads[2].finish();
    expect(await next).toBe('ready');
    expect(historyPacksState()).toBe('ready');
  }, 30_000);

  it.each(['finishes', 'fails'] as const)(
    "leaves the new player's read alone when the old player's read %s after it started (#699)",
    async (ending) => {
      setUp([RIGHT_NOW]);
      await savePack(RIGHT_NOW, 0);
      const old = hydrateMyPacks();
      await vi.waitFor(() => expect(reads).toHaveLength(1));

      // Another tab imports a different save, and this tab starts reading it before the old read ends.
      storePlayer('fd'.repeat(32), 1);
      const after = getPlayer();
      const history = JSON.parse(data.get(STORAGE_KEYS.HISTORY)!);
      history.push({ ...history[0], k: after.publicKeyHex.slice(0, 16), t: 9 });
      data.set(STORAGE_KEYS.HISTORY, JSON.stringify(history));
      const next = hydrateMyPacks();
      expect(myPackCacheState()).toBe('loading');

      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      if (ending === 'finishes') await reads[0].finish();
      else reads[0].fail(new Error('IndexedDB went away'));
      expect(await old).toBe('loading');
      // Neither ready nor failed: the old read says nothing about the new player's packs.
      expect(errors).not.toHaveBeenCalled();
      expect(myPackCacheState()).toBe('loading');
      expect(myStats()).toBeNull();
      expect(myProfileInfo()).toMatchObject({ packs: 1, cache: 'loading' });

      await vi.waitFor(() => expect(reads).toHaveLength(2));
      expect(reads[1].refs).toEqual([{ setKey: 'right-now@2', publicKeyHex: after.publicKeyHex, nonce: 0 }]);
      await reads[1].finish();
      await vi.waitFor(() => expect(reads).toHaveLength(3));
      expect(myPackCacheState()).toBe('ready');
      await reads[2].finish();
      expect(await next).toBe('ready');
      expect(historyPacksState()).toBe('ready');
      expect(errors).not.toHaveBeenCalled();
    },
    30_000,
  );

  it("keeps your own stats when another player's saved pack can't be read, and holds back only the history", async () => {
    const before = setUp([RIGHT_NOW]);
    await savePack(RIGHT_NOW, 0);
    // Then this device switched to a player with one pack of their own, also kept only in IndexedDB.
    storePlayer('fd'.repeat(32), 1);
    const after = getPlayer();
    const history = JSON.parse(data.get(STORAGE_KEYS.HISTORY)!);
    history.push({ ...history[0], k: after.publicKeyHex.slice(0, 16), t: 9 });
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify(history));
    const mine = await savePack(RIGHT_NOW, 0);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const run = hydrateMyPacks();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    // Only your own packs gate your stats.
    expect(reads[0].refs).toEqual([{ setKey: 'right-now@2', publicKeyHex: after.publicKeyHex, nonce: 0 }]);
    await reads[0].finish();
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    expect(reads[1].refs).toEqual([{ setKey: 'right-now@2', publicKeyHex: before.publicKeyHex.slice(0, 16), nonce: 0 }]);
    expect(historyAchievementsReady()).toBe(false);
    reads[1].fail(new Error('disk'));
    expect(await run).toBe('ready');

    expect(myPackCacheState()).toBe('ready');
    expect(myStats()).toEqual(profileStats([mine]));
    expect(myProfileInfo()).toMatchObject({ packs: 1, missing: 0, cache: 'ready' });
    expect(historyPacksState()).toBe('failed');
    // Achievements from your own packs aren't held back by another player's that can't be read.
    expect(historyAchievementsReady()).toBe(true);
    expect(errors).toHaveBeenCalledTimes(1);

    // The next run reads the history again; your own packs are already in.
    const retry = hydrateMyPacks();
    expect(historyPacksState()).toBe('loading');
    expect(myPackCacheState()).toBe('ready');
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    expect(reads[2].refs).toEqual(reads[1].refs);
    await reads[2].finish();
    expect(await retry).toBe('ready');
    expect(historyPacksState()).toBe('ready');
  }, 30_000);

  it("resolves as loading when aborted while reading another player's packs, with your own still ready", async () => {
    const before = setUp([RIGHT_NOW]);
    await savePack(RIGHT_NOW, 0);
    storePlayer('fd'.repeat(32), 1);
    const history = JSON.parse(data.get(STORAGE_KEYS.HISTORY)!);
    history.push({ ...history[0], k: getPlayer().publicKeyHex.slice(0, 16), t: 9 });
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify(history));
    await savePack(RIGHT_NOW, 0);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const controller = new AbortController();
    const run = hydrateMyPacks(controller.signal);
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    await reads[0].finish();
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    expect(reads[1].refs).toEqual([{ setKey: 'right-now@2', publicKeyHex: before.publicKeyHex.slice(0, 16), nonce: 0 }]);
    controller.abort();
    reads[1].fail(controller.signal.reason);
    expect(await run).toBe('loading');

    expect(myPackCacheState()).toBe('ready');
    expect(historyPacksState()).toBe('loading');
    expect(historyAchievementsReady()).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });

  it('aborts the read when the page unmounts or another tab switches player, without reporting a failure', async () => {
    setUp([RIGHT_NOW]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stop = watchMyPacks();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    expect(reads[0].signal?.aborted).toBe(false);

    // Another tab replaced the save: the read starts over.
    window.dispatchEvent(Object.assign(new Event('storage'), { key: null }));
    expect(reads[0].signal?.aborted).toBe(true);
    await vi.waitFor(() => expect(reads).toHaveLength(2));

    stop();
    expect(reads[1].signal?.aborted).toBe(true);
    // The aborted read settles (the next one only starts after it), as loading rather than failed.
    const next = hydrateMyPacks();
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    expect(myPackCacheState()).toBe('loading');
    expect(errors).not.toHaveBeenCalled();
    await reads[2].finish();
    expect(await next).toBe('ready');
  });

  it("doesn't re-open packs on load while saved ones couldn't be read, and keeps the run pending", async () => {
    const player = setUp([RIGHT_NOW]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    data.set(PENDING, player.publicKeyHex);
    resumeReopening();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    reads[0].fail(new Error('disk'));
    await vi.waitFor(() => expect(myPackCacheState()).toBe('failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reopenStatus()).toBeNull();
    expect(data.get(PENDING)).toBe(player.publicKeyHex);
    expect(errors).toHaveBeenCalledTimes(1);
  });
});

describe('the shared ticket list', () => {
  /** Everything built from the ticket list, read twice: as kept, then built again from nothing. */
  const views = () => ({
    stats: myStats(), progress: myProgress(), info: myProfileInfo(), own: myPackCacheState(), history: historyPacksState(), ready: historyAchievementsReady(),
  });
  const expectFresh = () => {
    const kept = views();
    resetTicketList();
    expect(kept).toEqual(views());
    return kept;
  };
  const secretOf = () => (JSON.parse(data.get('brainrot-player-v1')!) as { secretKey: string }).secretKey;
  const writeHistory = (entries: object[]) => data.set(STORAGE_KEYS.HISTORY, JSON.stringify(entries));
  /** A history entry holding its pack's cards, as opening the pack stores it, and that pack. */
  const opened = async (set: SetDefinition, nonce: number) => {
    const player = getPlayer();
    const cards = await derivePack(set, player.publicKey, nonce, computeTicket);
    const score = scorePulled(cards);
    const c = cards.map((x) => encodeCard({ id: x.cardId, holo: x.isHolo, finish: x.finish, misprint: x.misprint })).join(',');
    const entry = { s: set.id, v: set.version, n: nonce, k: player.publicKeyHex.slice(0, 16), c, h: score.hand.name, x: score.score, t: nonce + 1 };
    const pack: ProfilePack = { nonce, set, cards, score };
    return { entry, pack };
  };

  it('gives what a full rebuild gives after hydration, a new pack, an import and a player change', async () => {
    const player = setUp([GENESIS, RIGHT_NOW, RIGHT_NOW]);
    const packs = [await savePack(GENESIS, 0), await savePack(RIGHT_NOW, 1), await savePack(RIGHT_NOW, 2)];
    expect(expectFresh()).toMatchObject({ stats: null, own: 'loading' });

    // Hydration: packs reach memory, so the list is built again with them.
    const run = hydrateMyPacks();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    await reads[0].finish();
    expect(await run).toBe('ready');
    expect(expectFresh()).toMatchObject({ stats: profileStats(packs), own: 'ready' });

    // A new pack: the history gains a ticket with its cards, and the ticket count moves on.
    const next = await derivePack(RIGHT_NOW, player.publicKey, 3, computeTicket);
    const code = next.map((c) => encodeCard({ id: c.cardId, holo: c.isHolo, finish: c.finish, misprint: c.misprint })).join(',');
    const score = scorePulled(next);
    const history = JSON.parse(data.get(STORAGE_KEYS.HISTORY)!) as object[];
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify([...history, { s: 'right-now', v: 2, n: 3, k: player.publicKeyHex.slice(0, 16), c: code, h: score.hand.name, x: score.score, t: 4 }]));
    storePlayer((JSON.parse(data.get('brainrot-player-v1')!) as { secretKey: string }).secretKey, 4);
    const withNew = expectFresh();
    expect(withNew.stats).toEqual(profileStats([...packs, { nonce: 3, set: RIGHT_NOW, cards: next, score }]));
    expect(withNew.progress!.gained).toBeGreaterThan(0);

    // An import without tickets 0 and 3's set mappings: those packs no longer count.
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify(history.slice(1)));
    expect(expectFresh().info).toMatchObject({ packs: 4, filled: 2 });

    // Another player: nothing of the first player's list is shown.
    setUp([RIGHT_NOW]);
    expect(expectFresh()).toMatchObject({ stats: null, own: 'loading', info: { packs: 1 } });
  }, 30_000);

  it("swaps to another player's list when only the player record changes", async () => {
    // One history holding a pack each from two players, the same ticket count and the same store:
    // only the player tells the two lists apart.
    setUp([]);
    const secrets = ['a1'.repeat(32), 'b2'.repeat(32)];
    const history: object[] = [];
    const packs: ProfilePack[] = [];
    for (const secretKey of secrets) {
      storePlayer(secretKey, 1);
      const player = getPlayer();
      const cards = await derivePack(RIGHT_NOW, player.publicKey, 0, computeTicket);
      const code = cards.map((c) => encodeCard({ id: c.cardId, holo: c.isHolo, finish: c.finish, misprint: c.misprint })).join(',');
      const score = scorePulled(cards);
      history.push({ s: 'right-now', v: 2, n: 0, k: player.publicKeyHex.slice(0, 16), c: code, h: score.hand.name, x: score.score, t: history.length + 1 });
      packs.push({ nonce: 0, set: RIGHT_NOW, cards, score });
    }
    data.set(STORAGE_KEYS.HISTORY, JSON.stringify(history));
    storePlayer(secrets[0], 1);
    const first = expectFresh();
    expect(first.stats).toEqual(profileStats([packs[0]]));
    storePlayer(secrets[1], 1);
    const second = expectFresh();
    expect(second.stats).toEqual(profileStats([packs[1]]));
    expect(second.stats).not.toEqual(first.stats);
  }, 30_000);

  it('keeps one list through repeated reads and repeated notifications, and builds one per change', async () => {
    setUp([]);
    const secret = secretOf();
    const a = await opened(GENESIS, 0);
    const b = await opened(RIGHT_NOW, 1);
    writeHistory([a.entry, b.entry]);
    storePlayer(secret, 2);
    const kept = expectFresh();
    expect(kept.stats).toEqual(profileStats([a.pack, b.pack]));
    // Stats live on the list, so the same object means the list wasn't built (or scored) again.
    const stats = myStats();
    for (let i = 0; i < 3; i++) {
      // The same save written again (another tab, a repeated storage event) changes nothing.
      writeHistory([a.entry, b.entry]);
      storePlayer(secret, 2);
      expect(views()).toEqual(kept);
      expect(myStats()).toBe(stats);
    }
    const c = await opened(RIGHT_NOW, 2);
    writeHistory([a.entry, b.entry, c.entry]);
    storePlayer(secret, 3);
    const next = myStats();
    expect(next).not.toBe(stats);
    expect(myStats()).toBe(next);
    expect(expectFresh().stats).toEqual(profileStats([a.pack, b.pack, c.pack]));
  }, 30_000);

  it('builds the list again when only the ticket count moves on', async () => {
    setUp([]);
    const secret = secretOf();
    const a = await opened(GENESIS, 0);
    const b = await opened(RIGHT_NOW, 1);
    writeHistory([a.entry, b.entry]);
    storePlayer(secret, 2);
    expect(expectFresh().info).toMatchObject({ packs: 2 });
    // Another tab took ticket 2 and hasn't written its history yet: the same history, one more ticket.
    storePlayer(secret, 3);
    expect(expectFresh().info).toMatchObject({ packs: 3 });
  }, 30_000);

  it('builds the list again after a changed set version, a cache loss, a re-open landing and a reset', async () => {
    setUp([]);
    const secret = secretOf();
    const a = await opened(GENESIS, 0);
    const b = await opened(RIGHT_NOW, 1);
    writeHistory([a.entry, b.entry]);
    storePlayer(secret, 2);
    // Every pack is in the history, so nothing is read and the saved packs count as read.
    expect(await hydrateMyPacks()).toBe('ready');
    expect(reads).toHaveLength(0);
    expect(expectFresh().stats).toEqual(profileStats([a.pack, b.pack]));

    // Changed provenance: an import maps ticket 1 to the set's first version, so it's another pack.
    const old = await opened(RIGHT_NOW_V1, 1);
    writeHistory([a.entry, old.entry]);
    expect(expectFresh().stats).toEqual(profileStats([a.pack, old.pack]));

    // Cache loss: out of space, the history drops ticket 1's cards (history.ts write), and this device
    // never stored that pack, so it must be re-opened.
    writeHistory([a.entry, { ...old.entry, c: undefined }]);
    expect(expectFresh().info).toEqual({ packs: 2, filled: 0, missing: 1, cache: 'ready' });

    // Recovery: re-opening stores the pack (as reopen's batches do), so it counts again.
    await putStoredPacks([{ setKey: setKey(RIGHT_NOW_V1), publicKeyHex: getPlayer().publicKeyHex, nonce: 1, cards: old.entry.c }]);
    expect(expectFresh()).toMatchObject({ stats: profileStats([a.pack, old.pack]), info: { missing: 0 }, own: 'ready' });

    // Reset: a new save with no packs.
    data.delete(STORAGE_KEYS.HISTORY);
    storePlayer('fe'.repeat(32), 0);
    expect(expectFresh()).toMatchObject({ stats: profileStats([]), progress: { level: 1, xp: 0, gained: 0 }, info: null });
  }, 30_000);
});
