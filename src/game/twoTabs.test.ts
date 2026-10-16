// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import type { CollectionItem, Settings, Stats } from '../types';
import { guardProgress, type ProgressGuard } from './progressGuard';
import { createProgressWriter, type HeldProgress, type ProgressWriter } from './progressWriter';
import { onShelf, savePendingPack, type OpenedPack } from './pulls';

const KEY = 'ab'.repeat(32);
vi.mock('./player', () => ({
  getPlayer: () => ({ publicKeyHex: 'ab'.repeat(32) }),
  claimNonce: () => 0,
  peekNonce: () => 0,
}));
vi.mock('./history', () => ({ recordMissing: () => true, recordPack: () => true, recordTicket: () => true }));

const cards = getSet('right-now', 2)!.cards;
const stats = (packsOpened: number): Stats => ({ packsOpened, holoCards: {}, highestPackValue: 0, highestPackCards: [] });
const loaded: HeldProgress = { collection: {}, achievements: {}, stats: stats(0), hallOfFame: {}, settings: {} as Settings };
const pack = (nonce: number) =>
  ({ setId: 'right-now', setVersion: 2, nonce, publicKeyHex: KEY, cards: [], score: {}, openedAt: 1 }) as unknown as OpenedPack;
/** The progress a tab holds once it adds a pack: one card of its own, and one more pack counted. */
const withPack = (from: HeldProgress, card: number): HeldProgress => {
  const item: CollectionItem = { card: cards[card] as unknown as CollectionItem['card'], normalCount: 1, holoCount: 0 };
  return { ...from, collection: { ...from.collection, [cards[card].id]: item }, stats: stats(from.stats.packsOpened + 1) };
};

/** One tab: its guard, its writer, and whether it went stale. `beforeCheck` runs inside its next check, after it reads storage. */
const tab = () => {
  const guard: ProgressGuard = guardProgress();
  const state = { stale: false, failed: false, beforeCheck: null as (() => void) | null };
  let latched = false;
  const writer: ProgressWriter = createProgressWriter({
    samePlayer: () => true,
    progressCurrent: () => {
      const current = !latched && guard.current();
      // Chromium hands a tab's localStorage writes to other tabs a little later: this tab can read
      // storage as current, the other tab then stores its pack, and this tab writes over it.
      const run = state.beforeCheck;
      state.beforeCheck = null;
      run?.();
      if (!current) latched = true;
      return current;
    },
    noted: guard.noted,
    stale: () => { state.stale = true; },
    failed: () => { state.failed = true; },
    keptAside: () => {},
    storing: guard.storing, unstored: guard.unstored, dropped: guard.dropped,
  });
  writer.commit(loaded);
  return { guard, writer, state, putBack: () => { if (!latched && guard.current()) return; latched = true; writer.putBack(); } };
};

const read = (key: string) => JSON.parse(localStorage.getItem(key) ?? 'null');

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('two tabs of one player opening packs at once', () => {
  it('puts the pack a stale write dropped back on the shelf, so the next load adds and counts it', () => {
    const a = tab();
    const b = tab();
    // Each opens a pack: it goes on the shelf, then into the tab's collection.
    savePendingPack(pack(0));
    savePendingPack(pack(1));
    a.writer.packAdded(pack(0));
    b.writer.packAdded(pack(1));
    // A checks storage, B stores its pack and takes it off the shelf, then A stores over it.
    a.state.beforeCheck = () => b.writer.commit(withPack(loaded, 1));
    a.writer.commit(withPack(loaded, 0));
    expect(read(STORAGE_KEYS.STATS).packsOpened).toBe(1);
    expect(Object.keys(read(STORAGE_KEYS.COLLECTION))).toEqual([cards[0].id]);
    expect(onShelf(0)).toBe(false);

    // B hears A's write: B's pack is in neither the stored collection nor the shelf unless B puts it back.
    b.putBack();
    expect(onShelf(1)).toBe(true);
    // Uncounted, so the next load counts it (the stored stats count only A's).
    expect(read(STORAGE_KEYS.PENDING_PACKS).find((p: { n: number }) => p.n === 1)).not.toHaveProperty('d');
    // A's own pack is in the stored collection: it stays off the shelf.
    a.putBack();
    expect(onShelf(0)).toBe(false);
  });

  it('puts nothing back when the other tab stored after reading this tab\'s pack', () => {
    const a = tab();
    const b = tab();
    savePendingPack(pack(1));
    b.writer.packAdded(pack(1));
    b.writer.commit(withPack(loaded, 1));
    // A reloads its view of storage (as a fresh tab would) and stores its own pack over B's.
    a.guard.noted();
    savePendingPack(pack(0));
    a.writer.packAdded(pack(0));
    a.writer.commit({ ...withPack(withPack(loaded, 1), 0) });
    b.putBack();
    expect(onShelf(1)).toBe(false);
    expect(onShelf(0)).toBe(false);
  });
});
