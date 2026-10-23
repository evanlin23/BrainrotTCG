/**
 * Reading your saved packs into memory (game/packStore.ts), and whether they're all in yet. Built on
 * the ticket list (myTickets.ts); re-opening (reopenJob.ts) and profiles (profiles.ts) build on this.
 */
import { setKey } from '../engine';
import { getPlayer, getPlayerTickets } from './player';
import { getHistory } from './history';
import { hydratePackStore, packRefKey, type StoredPackRef } from './packStore';
import { awaitsCache, historyHasAllCards, myTickets, ticketList, type PlayerTickets, type Ticket } from './myTickets';

/*
 * Packs whose cards the history dropped live in IndexedDB (game/packStore.ts). Nothing loads the
 * whole store: they're read on demand, a bounded page at a time, in two steps. Your own tickets come
 * first (`state`): until they're in, anything that would count them isn't shown, so saved progress
 * reads as loading (or as a failed read), never as zero. Then the rest of the history (`history`,
 * other players' packs saved on this device), which only the history lists and achievements need:
 * a failed read there never hides your own stats.
 */
export type PackCacheState = 'loading' | 'ready' | 'failed';

const cache: {
  owner: string | null;
  state: PackCacheState;
  history: PackCacheState;
  gen: number;
  run: Promise<PackCacheState> | null;
  signal: AbortSignal | undefined;
} = { owner: null, state: 'loading', history: 'loading', gen: 0, run: null, signal: undefined };
const cacheListeners = new Set<() => void>();
let cacheVersion = 0;
let lastRun: Promise<unknown> = Promise.resolve();

const setCacheState = (state: PackCacheState, history: PackCacheState = cache.history) => {
  cache.state = state;
  cache.history = history;
  cacheVersion++;
  for (const listener of cacheListeners) listener();
};

/** Follow the pack cache (loading, ready or failed). Returns the unsubscribe function. */
export const onPackCacheChange = (listener: () => void): (() => void) => {
  cacheListeners.add(listener);
  return () => {
    cacheListeners.delete(listener);
  };
};

/** Changes whenever the pack cache's state does (for useSyncExternalStore). */
export const packCacheVersion = (): number => cacheVersion;

export const stateFor = (snapshot: PlayerTickets): PackCacheState =>
  cache.owner === snapshot.player.publicKeyHex ? cache.state : 'loading';

/** Whether this player's saved packs are all readable now: 'ready' when no ticket waits on the store. */
export const myPackCacheState = (): PackCacheState => {
  const snapshot = getPlayerTickets();
  return ticketList(snapshot).waiting ? stateFor(snapshot) : 'ready';
};

/**
 * Whether every pack in the history (yours and other players' saved on this device) is readable:
 * what history achievements need before they can name the right pack and date.
 */
export const historyPacksState = (): PackCacheState => {
  const own = myPackCacheState();
  if (own !== 'ready') return own;
  if (historyHasAllCards()) return 'ready';
  return cache.owner === getPlayer().publicKeyHex ? cache.history : 'loading';
};

/**
 * Whether achievements can be looked for in the history now: every pack in it is readable, or only
 * other players' packs failed to read. Those count by their hand alone (as a pack without cards
 * always has) rather than holding back achievements from your own packs until a reload.
 */
export const historyAchievementsReady = (): boolean => {
  const state = historyPacksState();
  if (state !== 'failed' || myPackCacheState() !== 'ready') return state === 'ready';
  const { publicKeyHex } = getPlayer();
  return getHistory().every(e => e.cards || !publicKeyHex.startsWith(e.key));
};

/** Your tickets waiting on the store. */
const myCacheRefs = (snapshot: PlayerTickets): Map<string, StoredPackRef> => {
  const refs = new Map<string, StoredPackRef>();
  const { publicKeyHex } = snapshot.player;
  for (const t of myTickets(snapshot)) {
    if (t.set && awaitsCache(t)) refs.set(packRefKey(setKey(t.set), publicKeyHex, t.nonce), { setKey: setKey(t.set), publicKeyHex, nonce: t.nonce });
  }
  return refs;
};

/** The rest of the history whose cards were dropped (other players' packs from an earlier save on this device). */
const historyCacheRefs = (skip: ReadonlyMap<string, StoredPackRef>): StoredPackRef[] => {
  const refs = new Map<string, StoredPackRef>();
  for (const e of getHistory()) {
    if (e.cards) continue;
    const key = `${e.setId}@${e.setVersion}`;
    const id = packRefKey(key, e.key, e.nonce);
    if (!skip.has(id) && !refs.has(id)) refs.set(id, { setKey: key, publicKeyHex: e.key, nonce: e.nonce });
  }
  return [...refs.values()];
};

/**
 * Read the current player's saved packs into memory, a page at a time, then the rest of the
 * history's. Calling it while a run for the same player is going joins that run. Resolves your own
 * packs' state: 'ready', 'failed', or 'loading' when the run was aborted or the player changed
 * before it finished (what it hadn't read yet is dropped). Never rejects.
 */
export const hydrateMyPacks = (signal?: AbortSignal): Promise<PackCacheState> => {
  const owner = getPlayer().publicKeyHex;
  if (cache.run && cache.owner === owner && !cache.signal?.aborted) return cache.run;
  const gen = ++cache.gen;
  const ownerChanged = cache.owner !== owner;
  cache.owner = owner;
  cache.signal = signal;
  if (ownerChanged || cache.state !== 'ready') setCacheState('loading', 'loading');
  else if (cache.history !== 'loading') setCacheState('ready', 'loading');
  const keep = () => cache.gen === gen && getPlayer().publicKeyHex === owner;
  const previous = lastRun;
  const run: Promise<PackCacheState> = (async () => {
    let mine: Map<string, StoredPackRef>;
    try {
      // One run reads at a time (the store allows two reads in flight; a page is never re-asked).
      await previous;
      signal?.throwIfAborted();
      if (!keep()) return 'loading';
      const snapshot = getPlayerTickets();
      if (snapshot.player.publicKeyHex !== owner) return 'loading';
      mine = myCacheRefs(snapshot);
      if ((mine.size > 0 && !(await hydratePackStore([...mine.values()], signal, keep))) || !keep()) return 'loading';
      setCacheState('ready');
    } catch (error) {
      if (signal?.aborted || !keep()) return 'loading';
      console.error('Reading saved packs failed', error);
      // Packs already read stay readable; only a first read that failed leaves them unknown.
      setCacheState(cache.state === 'ready' ? 'ready' : 'failed', 'failed');
      return cache.state;
    }
    // Your own stats are settled: a failed read of other players' packs only holds back the history.
    try {
      const rest = historyCacheRefs(mine);
      if ((rest.length > 0 && !(await hydratePackStore(rest, signal, keep))) || !keep()) return 'loading';
      setCacheState('ready', 'ready');
    } catch (error) {
      if (signal?.aborted || !keep()) return 'loading';
      console.error('Reading saved packs failed', error);
      setCacheState('ready', 'failed');
    }
    return 'ready';
  })().finally(() => {
    if (cache.gen === gen) {
      cache.run = null;
      cache.signal = undefined;
    }
  });
  cache.run = run;
  lastRun = run;
  return run;
};

/**
 * Keep the current player's saved packs read in: start now, and start over when another tab
 * switches player. Returns the stop function, which aborts a read still going (on unmount).
 */
export const watchMyPacks = (): (() => void) => {
  let controller = new AbortController();
  void hydrateMyPacks(controller.signal);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && getPlayer().publicKeyHex === cache.owner) return;
    controller.abort();
    controller = new AbortController();
    void hydrateMyPacks(controller.signal);
  };
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener('storage', onStorage);
    controller.abort();
  };
};

/**
 * Your ticket list when its packs can all be counted. Null while saved packs are still being read,
 * or couldn't be: stats then are null, since zero would read as lost progress.
 */
export const countableTickets = (): readonly Ticket[] | null => {
  const snapshot = getPlayerTickets();
  const list = ticketList(snapshot);
  return !list.waiting || stateFor(snapshot) === 'ready' ? list.tickets : null;
};
