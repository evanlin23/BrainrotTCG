/**
 * Profiles: your signed list of which set every ticket went to, from ticket #0 (engine/profile.ts).
 * Building one uses this device's pack history; viewing one re-opens every pack on the viewer's device
 * (profileVerification.ts).
 */
import {
  claimsFor,
  encodeProfile,
  profileStatsTracker,
  signProfile,
  type ProfilePack,
  type ProfileRun,
  type ProfileStats,
  type SetDefinition,
  xpForLevel,
} from '../engine';
import { getPlayerTickets } from './player';
import { siteUrl } from './pulls';
import { getBestCards, mergeBestCards, type BestCandidate, type BestCards } from './bestCards';
import { awaitsCache, myTickets, type Ticket } from './myTickets';
import { countableTickets, stateFor, type PackCacheState } from './packCache';
import { onReopenProgress, reopen } from './reopenJob';

// Verifying a shared profile lives in its own module; re-exported so existing imports keep working.
export { verifyProfileLive, type ProfileProgress, type VerifyProfileOptions } from './profileVerification';

export const profileUrl = (profile: string): string => `${siteUrl()}#/profile/${profile}`;

const requireOriginalMappings = (tickets: readonly Ticket[], total: number): readonly (Ticket & { set: SetDefinition })[] => {
  if (total === 0) return [];
  // Exactly tickets 0..total-1, in order: runsOf signs them by position.
  if (tickets.length !== total || tickets.some((ticket, i) => ticket.nonce !== i || !ticket.set || ticket.filled)) {
    throw new Error('Some original pack set/version mappings are missing. A complete profile cannot be proved from this save.');
  }
  return tickets as readonly (Ticket & { set: SetDefinition })[];
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
  const total = snapshot.nextNonce;
  if (total <= 0) return null;
  const tickets = myTickets(snapshot);
  let validSetCount = 0;
  let hasPackCount = 0;
  let waiting = false;
  for (const t of tickets) {
    if (t.set && !t.filled) validSetCount++;
    if (t.pack) hasPackCount++;
    if (awaitsCache(t)) waiting = true;
  }
  return {
    packs: total,
    filled: total - validSetCount,
    missing: total - hasPackCount,
    cache: waiting ? stateFor(snapshot) : 'ready',
  };
};

/**
 * Weighs every pack this device can recover for the current key into its Best cards (game/bestCards.ts)
 * and returns them. The weighed mark moves to the first ticket with no pack here, so the list reads as
 * complete only when every used ticket was weighed; else it's the best among the recoverable packs.
 * Cards in the pack store count once they're read in (hydrateMyPacks), so call again after that.
 */
export const syncMyBestCards = (): BestCards => {
  const snapshot = getPlayerTickets();
  const { player, nextNonce } = snapshot;
  const candidates: BestCandidate[] = [];
  for (const t of myTickets(snapshot)) {
    if (t.set && t.pack) candidates.push({ setId: t.set.id, setVersion: t.set.version, nonce: t.nonce, openedAt: t.openedAt, cards: t.pack.cards });
  }
  mergeBestCards(player.publicKeyHex, candidates, (weighed, taken) => {
    let through = 0;
    while (through < nextNonce && taken.has(through)) through++;
    return Math.max(weighed, through);
  });
  return getBestCards(player.publicKeyHex, nextNonce);
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
  if (requireOriginalMappings(myTickets(asked), asked.nextNonce).length === 0) return null;
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
  const tickets = requireOriginalMappings(myTickets(asked), asked.nextNonce);
  const packs = tickets.flatMap((t) => (t.pack ? [t.pack] : []));
  if (packs.length !== tickets.length) throw new Error('Some packs could not be re-opened');
  const { player } = asked;
  return encodeProfile(signProfile({ publicKey: player.publicKey, name: player.name, runs: runsOf(tickets), ...claimsFor(packs) }, player.secretKey));
};
export interface MyProgress {
  level: number;
  xp: number;
  gained: number;
  levelXp: number;
  nextXp: number;
}
/** Built once per ticket list, so repeated calls share one object until the list changes. */
const progressOf = new WeakMap<readonly Ticket[], Omit<MyProgress, 'levelXp' | 'nextXp'>>();
const statsOf = new WeakMap<readonly Ticket[], ProfileStats>();

/** Your level and XP now, and how much the newest pack added (the pack summary shows it). Null while loading. */
export const myProgress = (): MyProgress | null => {
  const tickets = countableTickets();
  if (!tickets) return null;
  let progress = progressOf.get(tickets);
  if (!progress) {
    const tracker = profileStatsTracker();
    let held: ProfilePack | null = null;
    for (const t of tickets) {
      if (!t.pack) continue;
      if (held) tracker.add(held);
      held = t.pack;
    }
    const before = tracker.snapshot();
    if (held) tracker.add(held);
    const now = tracker.snapshot();
    progress = { level: now.level, xp: now.xp, gained: now.xp - before.xp };
    progressOf.set(tickets, progress);
  }
  const { level, xp, gained } = progress;
  return { level, xp, gained, levelXp: xpForLevel(level), nextXp: xpForLevel(level + 1) };
};

/** Your stats from this device's history (no mining): what viewers of your profile will see. Null while loading. */
/** Shared with every caller until the list changes, so it's frozen: copy it before changing it. */
export const myStats = (): ProfileStats | null => {
  const tickets = countableTickets();
  if (!tickets) return null;
  let stats = statsOf.get(tickets);
  if (!stats) {
    const tracker = profileStatsTracker();
    for (const t of tickets) if (t.pack) tracker.add(t.pack);
    stats = Object.freeze(tracker.snapshot());
    statsOf.set(tickets, stats);
  }
  return stats;
};
