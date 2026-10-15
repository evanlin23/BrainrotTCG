import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { computeTicket, derivePack, profileStats, scorePulled, setKey, type ProfilePack, type SetDefinition } from '../engine';
import { encodeCard } from './cardCode';
import { getStoredPack, hydratePackStore, putStoredPacks, resetPackStore, type StoredPack, type StoredPackRef } from './packStore';
import { getPlayer } from './player';
import {
  hydrateMyPacks, myPackCacheState, myProfileInfo, myProgress, myStats, reopenStatus, resumeReopening, watchMyPacks,
} from './profiles';

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
const idOf = (p: StoredPackRef) => `${p.setKey}|${p.publicKeyHex.slice(0, 16)}|${p.nonce}`;

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
    expect(reads[1].refs[0]).toEqual({ setKey: 'right-now@2', publicKeyHex: after.publicKeyHex, nonce: 0 });
    await reads[1].finish();
    expect(await next).toBe('ready');
    expect(myStats()).toMatchObject({ packs: 0 });
  }, 30_000);

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
