/**
 * Stored stats this build can't read (bad bytes, the wrong shape, a field that breaks its rule) are never
 * reset by the next pack (#1053). At load their exact bytes are kept aside with the unreadable collection
 * data (game/collectionRecovery.ts), whose note tells the player and offers Download and Discard, and the
 * stats in use are rebuilt from what the save still proves: every field that is still readable, the
 * packs this key's history records, and the holo cards and best pack found there and in the collection.
 * App stores the rebuilt stats as soon as it has loaded (once the copy is stored, not only held for the
 * visit), so a discard sticks and a backup holds stats it can import; until then an export rebuilds them.
 * Not while the player record has no key that can be read: rebuilt from a stand-in key's empty history,
 * they would count no packs, and none opens until a backup or a new player replaces the record.
 */
import { STORAGE_KEYS } from '../constants';
import { scoreCards } from '../data/cards';
import type { CollectionItem, Stats } from '../types';
import { hydrateCollection } from '../utils/migrations';
import { getStoredData, setStoredData } from '../utils/storage';
import { keepUnreadableAside, keptInStorage, type CollectionSaveResult } from './collectionRecovery';
import { byBest, historyCards, historyForKey } from './history';
import { beatsBestPack } from './packProgress';
import { getPlayer } from './player';
import { isStats, STATS_FIELDS } from './saveFile';

/** A new player's stats. */
export const emptyStats = (): Stats => ({ packsOpened: 0, holoCards: {}, highestPackValue: 0, highestPackCards: [] });

export interface LoadedStats {
  stats: Stats;
  /**
   * Tickets the rebuilt stats count from the history. A pack taken off the pending shelf with one of
   * these is in the history already, so it counts as `counted` (it only adds its cards).
   */
  counted: ReadonlySet<number>;
  /** The stored stats were unreadable and these were rebuilt: App stores them right after load (unless the player record is unreadable). */
  rebuilt: boolean;
}

const NONE: ReadonlySet<number> = new Set();

const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Unparseable, or not stats as a backup file must hold them (game/saveFile.ts). */
export const statsUnreadable = (raw: string): boolean => {
  try {
    return !isStats(JSON.parse(raw));
  } catch {
    return true;
  }
};

/** The best pack's fields, kept or rebuilt together so they always describe one pack (read when used: saveFile imports this module). */
const bestFields = () => Object.keys(STATS_FIELDS).filter((key) => key.startsWith('highestPack'));

/** Unreadable stats, rebuilt from their readable fields, this key's history and the collection. */
const rebuild = (value: unknown, collection: Record<string, CollectionItem>): LoadedStats => {
  const valid = (key: string, v: unknown) => !has(STATS_FIELDS, key) || STATS_FIELDS[key](v);
  const kept: Record<string, unknown> = record(value)
    ? Object.fromEntries(Object.entries(value).filter(([key, v]) => valid(key, v)))
    : {};
  if (record(value) && bestFields().some((key) => has(value, key) && !has(kept, key))) {
    for (const key of bestFields()) delete kept[key];
  }
  const stats = { ...kept } as unknown as Stats;
  const publicKeyHex = getPlayer().publicKeyHex;
  const history = historyForKey(publicKeyHex);

  // A count still readable stands when the history holds no more packs (an older save's history may
  // start after its first packs). Otherwise the history's count of tickets, and its packs count as counted.
  let counted = NONE;
  const tickets = new Set(history.map((entry) => entry.nonce));
  if (typeof stats.packsOpened !== 'number' || stats.packsOpened < tickets.size) {
    stats.packsOpened = tickets.size;
    counted = tickets;
  }

  const holoCards = { ...stats.holoCards };
  for (const [key, item] of Object.entries(collection)) if ((item?.holoCount ?? 0) > 0) holoCards[key] = true;
  for (const entry of history) {
    for (const card of entry.cards ?? []) if (card.holo) holoCards[`${entry.setId}/${card.id}`] = true;
  }
  stats.holoCards = holoCards;

  // The history's best pack replaces a kept one it beats (a better pack may have opened since the stats broke).
  for (const entry of [...history].sort(byBest)) {
    const cards = historyCards(entry);
    if (!cards || cards.length === 0) continue;
    const { points, hand, score } = scoreCards(cards);
    if (beatsBestPack(score, stats)) {
      Object.assign(stats, {
        highestPackFlexValue: score,
        highestPackBaseValue: points,
        highestPackMultiplier: hand.multiplier,
        highestPackHandName: hand.name,
        highestPackCards: cards,
        highestPackRef: { setId: entry.setId, setVersion: entry.setVersion, nonce: entry.nonce, publicKeyHex },
        highestPackLegacy: false,
      });
    }
    break;
  }
  return { stats, counted, rebuilt: true };
};

const parse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/**
 * The stats to load. Unreadable ones are kept aside first (a repeat finds them kept already), then
 * rebuilt; the stored bytes stay as they were until persistStats replaces them (App has it do so at once).
 */
export const loadStats = (collection: Record<string, CollectionItem>): LoadedStats => {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEYS.STATS);
  } catch {
    // Unreadable storage: persistStats won't write over what it couldn't read either.
    return { stats: emptyStats(), counted: NONE, rebuilt: false };
  }
  if (raw === null) return { stats: emptyStats(), counted: NONE, rebuilt: false };
  const value = parse(raw);
  if (isStats(value)) return { stats: value as unknown as Stats, counted: NONE, rebuilt: false };
  keepUnreadableAside(STORAGE_KEYS.STATS, statsUnreadable);
  return rebuild(value, collection);
};

/** The stored stats as a backup file holds them: unreadable ones rebuilt as loadStats does, so the file imports again. */
export const exportedStats = (raw: string | null): string | null => {
  if (raw === null || !statsUnreadable(raw)) return raw;
  return JSON.stringify(rebuild(parse(raw), hydrateCollection(getStoredData(STORAGE_KEYS.COLLECTION, {}))).stats);
};

/**
 * Stores the stats, keeping unreadable stored stats aside first; 'blocked' when they stay as they were.
 * While their copy is held only for this visit (storage had no room for it), they stay stored for the
 * rest of it, so a reload keeps them aside again rather than losing them; a discard lets them go.
 */
export const persistStats = (next: Stats): CollectionSaveResult => {
  const kept = keepUnreadableAside(STORAGE_KEYS.STATS, statsUnreadable);
  if (kept === 'blocked' || (kept === 'archived' && !keptInStorage(STORAGE_KEYS.STATS))) return 'blocked';
  if (!setStoredData(STORAGE_KEYS.STATS, next)) return 'blocked';
  return kept === 'archived' ? 'recovered' : 'saved';
};
