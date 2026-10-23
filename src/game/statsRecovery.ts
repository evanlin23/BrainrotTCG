/**
 * Stored stats this build can't read (bad bytes, the wrong shape, a field that breaks its rule) are never
 * reset by the next pack (#1053). At load their exact bytes are kept aside with the unreadable collection
 * data (game/collectionRecovery.ts), whose note tells the player and offers Download and Discard, and the
 * stats in use are rebuilt from what the save still proves: every field that is still readable, the
 * packs this key's history records, and the holo cards and best pack found there and in the collection.
 */
import { STORAGE_KEYS } from '../constants';
import { scoreCards } from '../data/cards';
import type { CollectionItem, Stats } from '../types';
import { setStoredData } from '../utils/storage';
import { keepUnreadableAside, type CollectionSaveResult } from './collectionRecovery';
import { byBest, historyCards, historyForKey } from './history';
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

/** The best pack's fields, kept or rebuilt together so they always describe one pack. */
const BEST_FIELDS = Object.keys(STATS_FIELDS).filter((key) => key.startsWith('highestPack'));

/** Unreadable stats, rebuilt from their readable fields, this key's history and the collection. */
const rebuild = (value: unknown, collection: Record<string, CollectionItem>): LoadedStats => {
  const valid = (key: string, v: unknown) => !has(STATS_FIELDS, key) || STATS_FIELDS[key](v);
  const kept: Record<string, unknown> = record(value)
    ? Object.fromEntries(Object.entries(value).filter(([key, v]) => valid(key, v)))
    : {};
  if (record(value) && BEST_FIELDS.some((key) => has(value, key) && !has(kept, key))) {
    for (const key of BEST_FIELDS) delete kept[key];
  }
  const stats = { ...kept } as unknown as Stats;
  const publicKeyHex = getPlayer().publicKeyHex;
  const history = historyForKey(publicKeyHex);

  // A count still readable stands when the history holds no more packs (an older save's history may
  // start after its first packs). Otherwise the history's count, and its packs count as counted.
  let counted = NONE;
  if (typeof stats.packsOpened !== 'number' || stats.packsOpened < history.length) {
    stats.packsOpened = history.length;
    counted = new Set(history.map((entry) => entry.nonce));
  }

  const holoCards = { ...stats.holoCards };
  for (const [key, item] of Object.entries(collection)) if ((item?.holoCount ?? 0) > 0) holoCards[key] = true;
  for (const entry of history) {
    for (const card of entry.cards ?? []) if (card.holo) holoCards[`${entry.setId}/${card.id}`] = true;
  }
  stats.holoCards = holoCards;

  if (!stats.highestPackFlexValue && !stats.highestPackValue) {
    for (const entry of [...history].sort(byBest)) {
      const cards = historyCards(entry);
      if (!cards || cards.length === 0) continue;
      const { points, hand, score } = scoreCards(cards);
      Object.assign(stats, {
        highestPackFlexValue: score,
        highestPackBaseValue: points,
        highestPackMultiplier: hand.multiplier,
        highestPackHandName: hand.name,
        highestPackCards: cards,
        highestPackRef: { setId: entry.setId, setVersion: entry.setVersion, nonce: entry.nonce, publicKeyHex },
        highestPackLegacy: false,
      });
      break;
    }
  }
  return { stats, counted };
};

/**
 * The stats to load. Unreadable ones are kept aside first (a repeat finds them kept already), then
 * rebuilt; the stored bytes stay as they were until persistStats replaces them.
 */
export const loadStats = (collection: Record<string, CollectionItem>): LoadedStats => {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEYS.STATS);
  } catch {
    // Unreadable storage: persistStats won't write over what it couldn't read either.
    return { stats: emptyStats(), counted: NONE };
  }
  if (raw === null) return { stats: emptyStats(), counted: NONE };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch { /* Rebuilt below. */ }
  if (isStats(value)) return { stats: value as unknown as Stats, counted: NONE };
  keepUnreadableAside(STORAGE_KEYS.STATS, statsUnreadable);
  return rebuild(value, collection);
};

/** Stores the stats, keeping unreadable stored stats aside first; 'blocked' when they stay as they were. */
export const persistStats = (next: Stats): CollectionSaveResult => {
  const kept = keepUnreadableAside(STORAGE_KEYS.STATS, statsUnreadable);
  if (kept === 'blocked' || !setStoredData(STORAGE_KEYS.STATS, next)) return 'blocked';
  return kept === 'archived' ? 'recovered' : 'saved';
};
