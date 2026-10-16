/**
 * Profiles: your signed list of which set every ticket went to, from ticket #0 (engine/profile.ts).
 * Building one uses this device's pack history; viewing one re-opens every pack on the viewer's device.
 */
import {
  checkClaims,
  claimsTracker,
  checkProfile,
  claimsFor,
  derivePack,
  encodeProfile,
  openProfileTicket,
  ProofError,
  profileStatsTracker,
  scorePulled,
  setKey,
  signProfile,
  toHex,
  type CheckedProfile,
  type ProfilePack,
  type ProfileRun,
  type ProfileStats,
  type ProofRule,
  type PulledCard,
  type SetDefinition,
  xpForLevel,
} from '../engine';
import { getSet } from '../content/sets';
import { getPlayer, getPlayerTickets } from './player';
import { getHistory, historyForKey, type HistoryEntry } from './history';
import { getReopened, putReopened } from './reopenCache';
import { getStoredPack, hydratePackStore, putStoredPacks, type StoredPack, type StoredPackRef } from './packStore';
import { decodeCard, encodeCard, modifiersFor, type StoredCard } from './cardCode';
import { createTicketPool } from './ticketPool';
import { admitOptional } from './admission';

export const profileUrl = (profile: string): string => `${window.location.origin}${import.meta.env.BASE_URL}#/profile/${profile}`;

const toPulled = (stored: readonly StoredCard[], set: SetDefinition): PulledCard[] | null => {
  const cards = stored.map((c, slot) => {
    // This exact version's rarity: a later version may change it (spec section 12).
    const rarity = set.cards.find((card) => card.id === c.id)?.rarity;
    return rarity ? { setId: set.id, cardId: c.id, rarity, isHolo: c.holo, ...modifiersFor(c, set.modifiers === 1), slot } : null;
  });
  return cards.every((c) => c) ? (cards as PulledCard[]) : null;
};

interface Ticket {
  nonce: number;
  set: SetDefinition | null;
  /** Null when this device has no record of the pack (yet). */
  pack: ProfilePack | null;
  /** True when the original set/version mapping is missing or unavailable. */
  filled: boolean;
  /** True when the cards come from the re-opened pack store (game/packStore.ts), not the history. */
  fromCache: boolean;
  openedAt: number;
}

type PlayerTickets = ReturnType<typeof getPlayerTickets>;

/**
 * One original mapping per ticket. History keeps every conflicting record of a ticket (two tabs
 * spent the same ticket number, or a backup carried both; see recordPack), and a profile admits
 * the pack opened first with it: the earliest openedAt, then setId, then setVersion. Every read on
 * every device picks the same record whatever order they are stored in, and none is deleted.
 */
const firstOpened = (a: HistoryEntry, b: HistoryEntry): number =>
  a.openedAt - b.openedAt || (a.setId < b.setId ? -1 : a.setId > b.setId ? 1 : 0) || a.setVersion - b.setVersion;

/** Every used ticket; absent original mappings stay unknown rather than guessing a different pack. */
function* ticketsOf({ player, nextNonce: total }: PlayerTickets): Generator<Ticket> {
  const known = new Map<number, HistoryEntry>();
  for (const e of historyForKey(player.publicKeyHex)) {
    const other = known.get(e.nonce);
    if (!other || firstOpened(e, other) < 0) known.set(e.nonce, e);
  }
  const setOf = (e: HistoryEntry | undefined) => (e ? getSet(e.setId, e.setVersion) : undefined);
  for (let nonce = 0; nonce < total; nonce++) {
    const entry = known.get(nonce);
    const set = setOf(entry) ?? null;
    if (!set) {
      yield { nonce, set: null, pack: null, filled: true, fromCache: false, openedAt: entry?.openedAt ?? 0 };
      continue;
    }
    const fromHistory = entry?.cards && setOf(entry) ? toPulled(entry.cards, set) : null;
    // Packs re-opened by an older build were stored without their finishes and misprints; their
    // saved score gives them away. Treat them as unknown so they're re-opened properly.
    const intact = fromHistory && !(set.modifiers === 1 && scorePulled(fromHistory).score !== entry!.score);
    // Else the cards this device re-opened (game/packStore.ts).
    const reopened = intact ? null : getStoredPack(setKey(set), player.publicKeyHex, nonce);
    const cards = intact ? fromHistory : reopened ? toPulled(reopened.split(',').map(decodeCard), set) : null;
    const score = cards && scorePulled(cards);
    yield {
      nonce,
      set,
      pack: cards && score ? { nonce, set, cards, score } : null,
      filled: false,
      fromCache: !intact,
      openedAt: entry?.openedAt ?? 0,
    };
  }
}

const myTickets = (snapshot: PlayerTickets = getPlayerTickets()): Ticket[] => [...ticketsOf(snapshot)];

/** A ticket whose cards are in the pack store but not read into memory yet (or never re-opened). */
const awaitsCache = (t: Ticket): boolean => !!t.set && t.fromCache && !t.pack;

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

const stateFor = (snapshot: PlayerTickets): PackCacheState =>
  cache.owner === snapshot.player.publicKeyHex ? cache.state : 'loading';

/** Whether this player's saved packs are all readable now: 'ready' when no ticket waits on the store. */
export const myPackCacheState = (): PackCacheState => {
  const snapshot = getPlayerTickets();
  for (const t of ticketsOf(snapshot)) if (awaitsCache(t)) return stateFor(snapshot);
  return 'ready';
};

/**
 * Whether every pack in the history (yours and other players' saved on this device) is readable:
 * what history achievements need before they can name the right pack and date.
 */
export const historyPacksState = (): PackCacheState => {
  const own = myPackCacheState();
  if (own !== 'ready') return own;
  if (getHistory().every(e => e.cards)) return 'ready';
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

const refId = (key: string, publicKeyHex: string, nonce: number) => `${key}|${publicKeyHex.slice(0, 16)}|${nonce}`;

/** Your tickets waiting on the store. */
const myCacheRefs = (snapshot: PlayerTickets): Map<string, StoredPackRef> => {
  const refs = new Map<string, StoredPackRef>();
  const { publicKeyHex } = snapshot.player;
  for (const t of ticketsOf(snapshot)) {
    if (t.set && awaitsCache(t)) refs.set(refId(setKey(t.set), publicKeyHex, t.nonce), { setKey: setKey(t.set), publicKeyHex, nonce: t.nonce });
  }
  return refs;
};

/** The rest of the history whose cards were dropped (other players' packs from an earlier save on this device). */
const historyCacheRefs = (skip: ReadonlyMap<string, StoredPackRef>): StoredPackRef[] => {
  const refs = new Map<string, StoredPackRef>();
  for (const e of getHistory()) {
    if (e.cards) continue;
    const key = `${e.setId}@${e.setVersion}`;
    const id = refId(key, e.key, e.nonce);
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

const requireOriginalMappings = (tickets: Ticket[]): (Ticket & { set: SetDefinition })[] => {
  if (tickets.some((ticket) => !ticket.set || ticket.filled)) {
    throw new Error('Some original pack set/version mappings are missing. A complete profile cannot be proved from this save.');
  }
  return tickets as (Ticket & { set: SetDefinition })[];
};

const runsOf = (tickets: readonly { set: SetDefinition }[]): ProfileRun[] => {
  const runs: ProfileRun[] = [];
  for (const { set } of tickets) {
    const last = runs[runs.length - 1];
    if (last && last.setId === set.id && last.setVersion === set.version) last.count++;
    else runs.push({ setId: set.id, setVersion: set.version, count: 1 });
  }
  return runs;
};

export interface MyProfile {
  packs: number;
  /** Tickets whose original set/version mapping is missing or unavailable. */
  filled: number;
  /** Tickets whose packs must be re-opened before a profile can be signed. */
  missing: number;
  /** Whether `missing` is final: until the saved packs are read, some of them may just be loading. */
  cache: PackCacheState;
}

export const myProfileInfo = (): MyProfile | null => {
  const snapshot = getPlayerTickets();
  let packs = 0;
  let filled = 0;
  let missing = 0;
  let waiting = false;
  for (const t of ticketsOf(snapshot)) {
    packs++;
    if (t.filled) filled++;
    if (!t.pack) missing++;
    if (awaitsCache(t)) waiting = true;
  }
  if (packs === 0) return null;
  return { packs, filled, missing, cache: waiting ? stateFor(snapshot) : 'ready' };
};

/**
 * Sign your profile. Its claims (XP, best packs) must be exact, so any ticket this device has no
 * cards for is re-opened first (reopenMyPacks).
 *
 * Other tabs can write while that runs. The link proves the tickets used when it was asked for,
 * by the player who asked: a ticket another tab spends meanwhile (and may not have recorded yet)
 * waits for the next link, and a different player in storage by then is refused, never signed.
 */
export const myProfileProof = async (onProgress?: (done: number, total: number) => void): Promise<string | null> => {
  const asked = getPlayerTickets();
  if (requireOriginalMappings(myTickets(asked)).length === 0) return null;
  const stop = onProgress && onReopenProgress((s) => onProgress(s.done, s.total));
  try {
    await reopen(asked);
    // A run that was already going covers only the tickets it started with: re-open the rest.
    if (myTickets(asked).some((t) => t.set && !t.pack)) await reopen(asked);
  } finally {
    stop?.();
  }
  const now = getPlayerTickets();
  if (now.player.publicKeyHex !== asked.player.publicKeyHex || now.nextNonce < asked.nextNonce) {
    throw new Error('Your save changed while the profile link was being prepared. Try again.');
  }
  const tickets = requireOriginalMappings(myTickets(asked));
  const packs = tickets.flatMap((t) => (t.pack ? [t.pack] : []));
  if (packs.length !== tickets.length) throw new Error('Some packs could not be re-opened');
  const { player } = asked;
  return encodeProfile(signProfile({ publicKey: player.publicKey, name: player.name, runs: runsOf(tickets), ...claimsFor(packs) }, player.secretKey));
};

/*
 * Re-opening your packs runs on its own, not in the page that started it: closing the profile
 * doesn't stop it, and if the tab closes, the next visit carries on (resumeReopening). Packs are
 * saved in small batches as they're re-opened, so little work is lost either way.
 */
const REOPEN_PENDING_KEY = 'brainrot-reopen-pending-v1';
const SAVE_BATCH = 25;

export interface ReopenStatus {
  done: number;
  total: number;
  running: boolean;
  error?: string;
}

let job: { promise: Promise<void>; status: ReopenStatus } | null = null;
const listeners = new Set<(status: ReopenStatus) => void>();

/** The current (or last) re-opening run on this page, if any. */
export const reopenStatus = (): ReopenStatus | null => (job ? { ...job.status } : null);

/** Follow re-opening progress. Returns the unsubscribe function. */
export const onReopenProgress = (listener: (status: ReopenStatus) => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const setPending = (publicKeyHex: string | null) => {
  try {
    if (publicKeyHex) localStorage.setItem(REOPEN_PENDING_KEY, publicKeyHex);
    else localStorage.removeItem(REOPEN_PENDING_KEY);
  } catch {
    // Storage unavailable: it just won't resume on the next visit.
  }
};

/**
 * Re-open every ticket of yours this device has no cards for, on a pool of workers. Calling it while
 * it runs joins the run already going.
 */
export const reopenMyPacks = (): Promise<void> => reopen(getPlayerTickets());

/**
 * Saved packs are read first, so only packs the store doesn't have are re-opened. An automatic
 * resume waits for a read that failed or didn't finish (it stays pending for the next visit);
 * asking for it re-opens whatever couldn't be read.
 */
const reopen = async (snapshot: PlayerTickets, auto = false): Promise<void> => {
  if (job?.status.running) return job.promise;
  const { player } = snapshot;
  let state = await hydrateMyPacks();
  // The read joined was aborted (its page closed): read again for this run.
  if (state === 'loading') state = await hydrateMyPacks();
  if (getPlayer().publicKeyHex !== player.publicKeyHex) {
    throw new Error('Your save changed while your packs were being read. Try again.');
  }
  if (auto && state !== 'ready') return;
  if (job?.status.running) return job.promise;
  // A ticket without its original set/version can't be re-opened (that would guess a set). Only the
  // profile link refuses it (myProfileProof); every mapped ticket is still re-opened.
  const missing = myTickets(snapshot).filter((t): t is Ticket & { set: SetDefinition } => !!t.set && !t.pack);
  if (missing.length === 0) {
    setPending(null);
    return Promise.resolve();
  }
  setPending(player.publicKeyHex);
  const status: ReopenStatus = { done: 0, total: missing.length, running: true };
  let lastEmit = 0;
  const emit = (force = false) => {
    const now = performance.now();
    if (!force && now - lastEmit < 150) return;
    lastEmit = now;
    for (const listener of listeners) listener({ ...status });
  };

  const promise = (async () => {
    const pool = createTicketPool();
    // Optional work: each ticket waits for a free slot, so opening a pack never waits behind it.
    // A different save stops it before the next ticket; one already mining finishes.
    const stop = new AbortController();
    const ticket = (set: string, publicKey: Uint8Array, nonce: number) =>
      admitOptional(() => {
        if (getPlayer().publicKeyHex !== player.publicKeyHex) throw new Error('Your save changed while your packs were being re-opened. Try again.');
        return pool.ticket(set, publicKey, nonce);
      }, stop.signal);
    let batch: StoredPack[] = [];
    let saving = Promise.resolve();
    let onDisk = true;
    const save = () => {
      const packs = batch;
      batch = [];
      saving = saving.then(async () => {
        if (!(await putStoredPacks(packs))) onDisk = false;
      });
    };
    let complete = false;
    let next = 0;
    const work = async () => {
      while (next < missing.length) {
        const t = missing[next++];
        const cards = await derivePack(t.set, player.publicKey, t.nonce, ticket);
        const code = cards.map((c) => encodeCard({ id: c.cardId, holo: c.isHolo, finish: c.finish, misprint: c.misprint })).join(',');
        batch.push({ setKey: setKey(t.set), publicKeyHex: player.publicKeyHex, nonce: t.nonce, cards: code });
        if (batch.length >= SAVE_BATCH) save();
        status.done++;
        emit();
      }
    };
    try {
      // Twice as many loops as workers, so a worker never waits for the next ticket to be handed out.
      await Promise.all(Array.from({ length: Math.min(missing.length, pool.size * 2) }, work));
      complete = true;
    } catch (error) {
      status.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      stop.abort();
      pool.close();
      save();
      await saving;
      // Not until every pack is on disk: otherwise the next visit carries on.
      if (complete && onDisk) setPending(null);
      status.running = false;
      emit(true);
    }
  })();
  job = { promise, status };
  return promise;
};

/** On load: carry on re-opening if a run was left unfinished (the tab was closed) for this player. */
export const resumeReopening = () => {
  let pending: string | null = null;
  try {
    pending = localStorage.getItem(REOPEN_PENDING_KEY);
  } catch {
    return;
  }
  if (!pending) return;
  if (pending !== getPlayer().publicKeyHex) return setPending(null);
  reopen(getPlayerTickets(), true).catch((error) => console.error('Re-opening packs failed', error));
};

/**
 * Your packs in ticket order, one at a time (no array of every pack). False while saved packs are
 * still being read, or couldn't be: stats then are null, since zero would read as lost progress.
 */
const eachMyPack = (onPack: (pack: ProfilePack) => void): boolean => {
  const snapshot = getPlayerTickets();
  let waiting = false;
  for (const t of ticketsOf(snapshot)) {
    if (awaitsCache(t)) waiting = true;
    if (t.pack) onPack(t.pack);
  }
  return !waiting || stateFor(snapshot) === 'ready';
};

export interface MyProgress {
  level: number;
  xp: number;
  gained: number;
  levelXp: number;
  nextXp: number;
}

/** Your level and XP now, and how much the newest pack added (the pack summary shows it). Null while loading. */
export const myProgress = (): MyProgress | null => {
  const tracker = profileStatsTracker();
  const held: { pack: ProfilePack | null } = { pack: null };
  const ready = eachMyPack((pack) => {
    if (held.pack) tracker.add(held.pack);
    held.pack = pack;
  });
  if (!ready) return null;
  const before = tracker.snapshot();
  if (held.pack) tracker.add(held.pack);
  const now = tracker.snapshot();
  return { level: now.level, xp: now.xp, gained: now.xp - before.xp, levelXp: xpForLevel(now.level), nextXp: xpForLevel(now.level + 1) };
};

/** Your stats from this device's history (no mining): what viewers of your profile will see. Null while loading. */
export const myStats = (): ProfileStats | null => {
  const tracker = profileStatsTracker();
  return eachMyPack((pack) => tracker.add(pack)) ? tracker.snapshot() : null;
};

export interface ProfileProgress {
  checked: CheckedProfile;
  /** Packs re-opened so far, in ticket order. */
  packs: ProfilePack[];
  /** The packs the profile names as its best, once they're re-opened (they go first). */
  highlights: ProfilePack[] | null;
  /** Every pack re-opened and the claims match. */
  done: boolean;
  /** Set when the profile turned out not to be real (rule "claims") or re-opening failed. */
  error?: { rule?: ProofRule; message: string };
}

/**
 * Check a profile, then re-open its packs on a pool of workers, its claimed best packs first,
 * reporting as they finish; when every pack is in, check its claims. Packs this device has
 * re-opened before come from its cache. `checkProfile` errors (bad signature, unknown set, ...)
 * are thrown before anything is re-opened.
 */
export const verifyProfileLive = (text: string, onProgress: (p: ProfileProgress) => void, signal: AbortSignal): CheckedProfile => {
  const checked = checkProfile(text, getSet);
  const { profile, tickets } = checked;
  const total = tickets.length;
  const keyHex = toHex(profile.publicKey);
  const results: (ProfilePack | undefined)[] = new Array(total);
  const order = [...profile.highlights, ...Array.from({ length: total }, (_, n) => n).filter((n) => !profile.highlights.includes(n))];
  let pool: ReturnType<typeof createTicketPool> | null = null;
  let next = 0;
  let finished = 0;
  let lastReport = 0;
  // Made-up claims usually show long before the last pack: stop re-opening as soon as they do.
  const tracker = claimsTracker(profile, tickets);
  let ruledOut: string | null = tracker.initial();

  const snapshot = (extra: Partial<ProfileProgress> = {}): ProfileProgress => {
    const highlights = profile.highlights.map((n) => results[n]);
    return {
      checked,
      packs: results.filter((p): p is ProfilePack => !!p),
      highlights: highlights.every((p) => p) ? (highlights as ProfilePack[]) : null,
      done: false,
      ...extra,
    };
  };
  const report = (force = false) => {
    const now = performance.now();
    if (!force && now - lastReport < 150) return;
    lastReport = now;
    onProgress(snapshot());
  };

  const open = async (nonce: number) => {
    const set = tickets[nonce];
    const cached = getReopened(set, keyHex, nonce);
    if (cached) return { nonce, set, cards: cached, score: scorePulled(cached) };
    pool ??= createTicketPool();
    const { ticket } = pool;
    // Optional work: each ticket waits for a free slot, so opening a pack never waits behind it.
    const pack = await openProfileTicket(checked, nonce, (set, key, n) => admitOptional(() => ticket(set, key, n), signal));
    putReopened(set, keyHex, nonce, pack.cards);
    return pack;
  };

  const work = async () => {
    while (!signal.aborted && !ruledOut && next < total) {
      const nonce = order[next++];
      const pack = await open(nonce);
      results[nonce] = pack;
      finished++;
      ruledOut ??= tracker.add(pack);
      report(finished <= profile.highlights.length);
    }
  };

  signal.addEventListener('abort', () => pool?.close(), { once: true });
  const workers = Math.min(total, 8);
  Promise.all(Array.from({ length: workers }, work))
    .then(() => {
      if (signal.aborted) return;
      if (ruledOut) {
        onProgress(snapshot({ error: { rule: 'claims', message: ruledOut } }));
        return;
      }
      try {
        checkClaims(profile, results as ProfilePack[]);
        onProgress(snapshot({ done: true }));
      } catch (error) {
        const rule = error instanceof ProofError ? error.rule : undefined;
        onProgress(snapshot({ error: { rule, message: error instanceof Error ? error.message : String(error) } }));
      }
    })
    .catch((error) => {
      if (signal.aborted) return;
      console.error('Profile verification failed', error);
      onProgress(snapshot({ error: { message: String(error) } }));
    })
    .finally(() => pool?.close());
  report(true);
  return checked;
};
