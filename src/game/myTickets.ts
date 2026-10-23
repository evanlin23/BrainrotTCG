/**
 * Your tickets as this device knows them: one per pack you opened, from the stored history and the
 * packs re-opened into the pack store (game/packStore.ts). The list is built once per change and
 * shared by the pack cache (packCache.ts), re-opening (reopenJob.ts) and profiles (profiles.ts).
 * It reads and never writes, and it imports none of them.
 */
import { scorePulled, setKey, type ProfilePack, type SetDefinition } from '../engine';
import { getSet } from '../content/sets';
import { getPlayerTickets } from './player';
import { firstOpened, getHistory, historyForKey, storedHistory, type HistoryEntry } from './history';
import { getStoredPack, packStoreVersion } from './packStore';
import { decodeCards, toPulled } from './cardCode';

/** A ticket whose cards are in the pack store but not read into memory yet (or never re-opened). */
export const awaitsCache = (t: Ticket): boolean => !!t.set && t.fromCache && !t.pack;

export interface Ticket {
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

export type PlayerTickets = ReturnType<typeof getPlayerTickets>;

/** Every used ticket with recorded history; absent original mappings stay unknown rather than guessing a different pack. */
function* ticketsOf({ player, nextNonce: total }: PlayerTickets): Generator<Ticket> {
  const known = new Map<number, HistoryEntry>();
  for (const e of historyForKey(player.publicKeyHex)) {
    // A tampered entry's nonce can be a fraction or a string: it is no ticket, and must not stand in for one.
    if (!Number.isSafeInteger(e.nonce) || e.nonce < 0 || e.nonce >= total) continue;
    const other = known.get(e.nonce);
    if (!other || firstOpened(e, other) < 0) known.set(e.nonce, e);
  }
  const setOf = (e: HistoryEntry | undefined) => (e ? getSet(e.setId, e.setVersion) : undefined);
  const sortedNonces = Array.from(known.keys()).sort((a, b) => a - b);
  for (const nonce of sortedNonces) {
    const entry = known.get(nonce);
    const set = setOf(entry) ?? null;
    if (!set) {
      yield { nonce, set: null, pack: null, filled: true, fromCache: false, openedAt: entry?.openedAt ?? 0 };
      continue;
    }
    const fromHistory = entry?.cards && setOf(entry) ? toPulled(entry.cards, set) : null;
    // Packs re-opened by an older build were stored without their finishes and misprints; their
    // saved score gives them away. Treat them as unknown so they're re-opened properly.
    const historyScore = fromHistory && scorePulled(fromHistory);
    const intact = fromHistory && !(set.modifiers === 1 && historyScore!.score !== entry!.score);
    // Else the cards this device re-opened (game/packStore.ts).
    const reopened = intact ? null : getStoredPack(setKey(set), player.publicKeyHex, nonce);
    const reopenedCards = reopened ? decodeCards(reopened) : null;
    const cards = intact ? fromHistory : reopenedCards ? toPulled(reopenedCards, set) : null;
    const score = intact ? historyScore : cards && scorePulled(cards);
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

/**
 * The last ticket list built, with what it was built from: the stored history, the player, the
 * ticket count and the pack store's contents. Any change to one builds the list again, so it never
 * goes stale; it saves rebuilding (and re-scoring) every pack several times for one pack opened.
 * Whether saved packs are still loading is never kept here: callers ask the pack cache each time.
 * The list (one ticket per pack this player opened) stays in memory until one of those changes.
 */
export interface TicketList {
  history: number;
  publicKeyHex: string;
  total: number;
  store: number;
  tickets: readonly Ticket[];
  /** Some ticket waits on the pack store (awaitsCache). */
  waiting: boolean;
}
let lastTickets: TicketList | null = null;

/**
 * Counts changes to the stored history, so the caches below compare a number and keep one copy of
 * the history string between them rather than one each.
 */
let seenHistory: string | null | undefined;
let historyChanges = 0;
const historyVersion = (): number => {
  const raw = storedHistory();
  if (raw !== seenHistory) {
    seenHistory = raw;
    historyChanges++;
  }
  return historyChanges;
};

export const ticketList = ({ player, nextNonce }: PlayerTickets): TicketList => {
  const history = historyVersion();
  const store = packStoreVersion();
  const last = lastTickets;
  if (last && last.history === history && last.publicKeyHex === player.publicKeyHex && last.total === nextNonce && last.store === store) return last;
  const tickets = [...ticketsOf({ player, nextNonce })];
  // Building can read stored packs but never changes them, so `store` still names what was read.
  return lastTickets = { history, publicKeyHex: player.publicKeyHex, total: nextNonce, store, tickets, waiting: tickets.some(awaitsCache) };
};

/** Shared and read-only: don't change the list or its tickets. */
export const myTickets = (snapshot: PlayerTickets = getPlayerTickets()): readonly Ticket[] => ticketList(snapshot).tickets;

/** For tests: forget the last ticket list. */
export const resetTicketList = () => {
  lastTickets = null;
  allCards = null;
  seenHistory = undefined;
};

/** Whether every history entry has its cards, worked out again only when the history or pack store changes. */
let allCards: { history: number; store: number; value: boolean } | null = null;
export const historyHasAllCards = (): boolean => {
  const history = historyVersion();
  const store = packStoreVersion();
  if (allCards?.history !== history || allCards.store !== store) allCards = { history, store, value: getHistory().every(e => e.cards) };
  return allCards.value;
};
