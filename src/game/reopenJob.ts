/**
 * Re-opening the packs this device has no cards for, on a pool of workers, and resuming that on the
 * next visit. Reads saved packs first (packCache.ts); profiles (profiles.ts) build on this.
 */
import { derivePack, setKey, type SetDefinition } from '../engine';
import { getPlayer, getPlayerTickets } from './player';
import { putStoredPacks, type StoredPack } from './packStore';
import { encodeCard } from './cardCode';
import { createTicketPool } from './ticketPool';
import { admitOptional } from './admission';
import { hydrateMyPacks } from './packCache';
import { myTickets, type PlayerTickets, type Ticket } from './myTickets';

/*
 * Re-opening your packs runs on its own, not in the page that started it: closing the profile
 * doesn't stop it, and if the tab closes, the next visit carries on (resumeReopening). Packs are
 * saved in small batches as they're re-opened, so little work is lost either way.
 */
const REOPEN_PENDING_KEY = 'brainrot-reopen-pending-v1';
const SAVE_BATCH = 25;
/*
 * When re-opened packs couldn't be saved (storage full), the next visit would mine them all again
 * only to fail the same way. So an automatic resume waits: 5 minutes after the first failure,
 * doubling each time up to a day. Asking to re-open (reopenMyPacks) never waits.
 */
const REOPEN_BACKOFF_KEY = 'brainrot-reopen-backoff-v1';
const BACKOFF_FIRST_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 24 * 60 * 60_000;
const BACKOFF_MAX_FAILURES = 16;

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
    else {
      localStorage.removeItem(REOPEN_PENDING_KEY);
      localStorage.removeItem(REOPEN_BACKOFF_KEY);
    }
  } catch {
    // Storage unavailable: it just won't resume on the next visit.
  }
};

/** Failed saves so far and when an automatic resume may try again, for this player only. */
const readBackoff = (publicKeyHex: string): { failures: number; retryAt: number } | null => {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(REOPEN_BACKOFF_KEY) ?? 'null');
    if (typeof value !== 'object' || value === null) return null;
    const { publicKeyHex: owner, failures, retryAt } = value as Record<string, unknown>;
    if (owner !== publicKeyHex || !Number.isInteger(failures) || (failures as number) < 1 || typeof retryAt !== 'number' || !Number.isFinite(retryAt)) return null;
    // Further off than the longest wait: written while the clock was ahead, or corrupt. Clamping to
    // now + the longest wait would move along with now and never end, so it's due at once instead.
    const now = Date.now();
    return { failures: failures as number, retryAt: retryAt > now + BACKOFF_MAX_MS ? now : retryAt };
  } catch {
    return null;
  }
};

const backOff = (publicKeyHex: string) => {
  const failures = Math.min((readBackoff(publicKeyHex)?.failures ?? 0) + 1, BACKOFF_MAX_FAILURES);
  const retryAt = Date.now() + Math.min(BACKOFF_FIRST_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  try {
    localStorage.setItem(REOPEN_BACKOFF_KEY, JSON.stringify({ publicKeyHex, failures, retryAt }));
  } catch {
    // Can't even note the wait: stop resuming on its own rather than mine everything every visit.
    setPending(null);
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
export const reopen = async (snapshot: PlayerTickets, auto = false): Promise<void> => {
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
      // Not until every pack is on disk: otherwise the next visit carries on, after a wait if saving failed.
      if (complete && onDisk) setPending(null);
      else if (!onDisk) backOff(player.publicKeyHex);
      status.running = false;
      emit(true);
    }
  })();
  job = { promise, status };
  return promise;
};

/**
 * On load: carry on re-opening if a run was left unfinished (the tab was closed) for this player,
 * unless it's still waiting after packs couldn't be saved. Returns the run it started, if any.
 */
export const resumeReopening = (): Promise<void> | undefined => {
  let pending: string | null;
  try {
    pending = localStorage.getItem(REOPEN_PENDING_KEY);
  } catch {
    return;
  }
  if (!pending) return;
  if (pending !== getPlayer().publicKeyHex) {
    setPending(null);
    return;
  }
  const backoff = readBackoff(pending);
  if (backoff && Date.now() < backoff.retryAt) return;
  return reopen(getPlayerTickets(), true).catch((error) => console.error('Re-opening packs failed', error));
};
