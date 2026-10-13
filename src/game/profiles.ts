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
  profileStats,
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
import { DEFAULT_SET_ID, getLatestSet, getSet } from '../content/sets';
import { getPlayer, peekNonce } from './player';
import { historyForKey, type HistoryEntry } from './history';
import { getReopened, putReopened } from './reopenCache';
import { getStoredPack, putStoredPacks, type StoredPack } from './packStore';
import { decodeCard, encodeCard, modifiersFor, type StoredCard } from './cardCode';
import { createTicketPool } from './ticketPool';

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
  set: SetDefinition;
  /** Null when this device has no record of the pack (yet). */
  pack: ProfilePack | null;
  /** True when the set is a guess: the ticket isn't in the history at all. */
  filled: boolean;
  openedAt: number;
}

/**
 * Every ticket this key has used, 0..nextNonce-1. A ticket with no record takes the set of the one
 * before it (or after it): its pack was never seen, so any set is as good, and leaving it out isn't
 * allowed.
 */
const myTickets = (): Ticket[] => {
  const player = getPlayer();
  const total = peekNonce();
  const known = new Map(historyForKey(player.publicKeyHex).map((e) => [e.nonce, e]));
  const setOf = (e: HistoryEntry | undefined) => (e ? getSet(e.setId, e.setVersion) : undefined);
  const firstKnown = [...known.values()].map(setOf).find((s) => s);
  let previous: SetDefinition = firstKnown ?? getLatestSet(DEFAULT_SET_ID)!;
  let previousTime = 0;
  const tickets: Ticket[] = [];
  for (let nonce = 0; nonce < total; nonce++) {
    const entry = known.get(nonce);
    const set = setOf(entry) ?? previous;
    const fromHistory = entry?.cards && setOf(entry) ? toPulled(entry.cards, set) : null;
    // Packs re-opened by an older build were stored without their finishes and misprints; their
    // saved score gives them away. Treat them as unknown so they're re-opened properly.
    const intact = fromHistory && !(set.modifiers === 1 && scorePulled(fromHistory).score !== entry!.score);
    // Else the cards this device re-opened (game/packStore.ts).
    const reopened = intact ? null : getStoredPack(setKey(set), player.publicKeyHex, nonce);
    const cards = intact ? fromHistory : reopened ? toPulled(reopened.split(',').map(decodeCard), set) : null;
    const score = cards && scorePulled(cards);
    tickets.push({
      nonce,
      set,
      pack: cards && score ? { nonce, set, cards, score } : null,
      filled: !setOf(entry),
      openedAt: entry?.openedAt ?? previousTime,
    });
    previous = set;
    previousTime = entry?.openedAt ?? previousTime;
  }
  return tickets;
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
  /** Tickets this device has no record of (opened before pack history existed). */
  filled: number;
  /** Tickets whose packs must be re-opened before a profile can be signed. */
  missing: number;
}

export const myProfileInfo = (): MyProfile | null => {
  const tickets = myTickets();
  if (tickets.length === 0) return null;
  return { packs: tickets.length, filled: tickets.filter((t) => t.filled).length, missing: tickets.filter((t) => !t.pack).length };
};

/**
 * Sign your profile. Its claims (XP, best packs) must be exact, so any ticket this device has no
 * cards for is re-opened first (reopenMyPacks).
 */
export const myProfileProof = async (onProgress?: (done: number, total: number) => void): Promise<string | null> => {
  if (myTickets().length === 0) return null;
  const stop = onProgress && onReopenProgress((s) => onProgress(s.done, s.total));
  try {
    await reopenMyPacks();
  } finally {
    stop?.();
  }
  const tickets = myTickets();
  const packs = tickets.flatMap((t) => (t.pack ? [t.pack] : []));
  if (packs.length !== tickets.length) throw new Error('Some packs could not be re-opened');
  const player = getPlayer();
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
export const reopenMyPacks = (): Promise<void> => {
  if (job?.status.running) return job.promise;
  const player = getPlayer();
  const missing = myTickets().filter((t) => !t.pack);
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
    let batch: StoredPack[] = [];
    let saving = Promise.resolve();
    const save = () => {
      const packs = batch;
      batch = [];
      saving = saving.then(() => putStoredPacks(packs));
    };
    let next = 0;
    const work = async () => {
      while (next < missing.length) {
        const t = missing[next++];
        const cards = await derivePack(t.set, player.publicKey, t.nonce, pool.ticket);
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
      setPending(null);
    } catch (error) {
      status.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      pool.close();
      save();
      await saving;
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
  reopenMyPacks().catch((error) => console.error('Re-opening packs failed', error));
};

/** Your level and XP now, and how much the newest pack added (the pack summary shows it). */
export const myProgress = () => {
  const packs = myTickets().flatMap((t) => (t.pack ? [t.pack] : []));
  const now = profileStats(packs);
  const before = profileStats(packs.slice(0, -1));
  return { level: now.level, xp: now.xp, gained: now.xp - before.xp, levelXp: xpForLevel(now.level), nextXp: xpForLevel(now.level + 1) };
};

/** Your stats from this device's history (no mining): what viewers of your profile will see. */
export const myStats = (): ProfileStats => profileStats(myTickets().flatMap((t) => (t.pack ? [t.pack] : [])));

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
    const pack = await openProfileTicket(checked, nonce, pool.ticket);
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
