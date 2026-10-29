/**
 * One-time migrations of locally saved data. Runs before the app reads storage.
 *
 * v2: cards moved into sets with slug ids, and collections are keyed by
 * `${setId}/${cardId}`. Old saves used image file names as ids.
 */
import legacyGenesisIds from '../content/sets/genesis/legacy-ids.json';
import { CARD_RARITIES, getCard, scoreCards, type Card } from '../data/cards';
import { STORAGE_KEYS } from '../constants';
// A cycle (collectionRecovery reads collectionNeedsRecovery from here), safe because both only call at run time.
import { keepUnreadableAside } from '../game/collectionRecovery';

export const DATA_VERSION_KEY = 'brainrot-data-version';
export const CURRENT_DATA_VERSION = 3;
const CURRENT_VERSION = CURRENT_DATA_VERSION;

/** After importing a save written by an older version: the next runMigrations() upgrades it. */
export const setDataVersion = (version: number): boolean => {
  try {
    localStorage.setItem(DATA_VERSION_KEY, String(version));
    return true;
  } catch {
    return false;
  }
};

const LEGACY: Record<string, string> = legacyGenesisIds;

/** Map an old card id or new key to the current collection key. */
export const migrateCardKey = (idOrKey: string): string => {
  if (idOrKey.includes('/')) return idOrKey;
  if (LEGACY[idOrKey]) return `genesis/${LEGACY[idOrKey]}`;
  return `genesis/${idOrKey}`;
};

/** Re-resolve a stored card against the registry so names and image URLs are always current. */
export const hydrateCard = <T extends Partial<Card> & { id: string }>(stored: T): T & Card => {
  const current = getCard(stored.key ?? migrateCardKey(stored.id));
  return current ? { ...stored, ...current } : ({ ...stored, key: stored.key ?? migrateCardKey(stored.id) } as T & Card);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isReadableCard = (value: unknown): value is Partial<Card> & { id: string } => {
  if (!isRecord(value) || typeof value.id !== 'string' || (value.key !== undefined && typeof value.key !== 'string')) return false;
  if (getCard(value.key ?? migrateCardKey(value.id))) return true;
  // Keep complete historical cards absent from the registry, but partial unknown
  // records cannot safely supply the display fields that registry hydration fills.
  return typeof value.setId === 'string' && typeof value.name === 'string' && typeof value.image === 'string'
    && typeof value.rarity === 'string' && Object.prototype.hasOwnProperty.call(CARD_RARITIES, value.rarity)
    && (value.caption === undefined || typeof value.caption === 'string')
    && (value.flavor === undefined || typeof value.flavor === 'string');
};

const isReadablePackCard = (value: unknown): value is AnyRecord => {
  if (!isRecord(value)) return false;
  const rawId = value.id ?? value.key;
  if (typeof rawId !== 'string' && typeof rawId !== 'number') return false;
  const idStr = String(rawId).trim();
  if (!idStr) return false;
  const key = typeof value.key === 'string' ? value.key : migrateCardKey(idStr);
  if (getCard(key)) return true;
  return typeof value.setId === 'string' && typeof value.name === 'string' && typeof value.image === 'string'
    && typeof value.rarity === 'string' && Object.prototype.hasOwnProperty.call(CARD_RARITIES, value.rarity);
};

/** The stored copy counts: the legacy `count` is a normal count too, and readers use it before or after normalCount. */
const COUNT_FIELDS = ['normalCount', 'holoCount', 'count'] as const;

/** What a stored copy count reads as: a non-negative whole number. Missing or null (migrateV2's unreadable count) reads as none. */
const isCountOrNone = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

/** A count the save can't hold (#1109): negative or non-integer reads as the whole copies it can stand for, else 0. */
const repairCount = (value: unknown): number =>
  (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER) : 0);

const hasBadCount = (item: Record<string, unknown>): boolean => COUNT_FIELDS.some((field) => !isCountOrNone(item[field]));

/** The entry with every bad count repaired; the same object when there is none, so a valid save reads unchanged. */
const withRepairedCounts = <T extends Record<string, unknown>>(item: T): T => {
  if (!hasBadCount(item)) return item;
  const repaired: Record<string, unknown> = { ...item };
  for (const field of COUNT_FIELDS) if (!isCountOrNone(item[field])) repaired[field] = repairCount(item[field]);
  return repaired as T;
};

/**
 * Refresh readable collection cards without rewriting the original saved payload. A readable entry
 * with a negative or non-integer count is read with that count repaired, so every reader sees the
 * same copies; collectionNeedsRepair tells the next write to keep the original bytes aside first.
 */
export function hydrateCollection<T extends { card: Partial<Card> & { id: string } }>(collection: Record<string, T>): Record<string, T & { card: Card }>;
export function hydrateCollection(collection: unknown): Record<string, { card: Card }>;
export function hydrateCollection(collection: unknown): Record<string, { card: Card }> {
  if (!isRecord(collection)) return {};
  const entries: [string, { card: Card }][] = [];
  for (const [key, item] of Object.entries(collection)) {
    if (isRecord(item) && isReadableCard(item.card)) {
      entries.push([key, { ...withRepairedCounts(item), card: hydrateCard(item.card) }]);
    }
  }
  return Object.fromEntries(entries);
}

/** True when displaying this payload would leave out any original collection record. */
export const collectionNeedsRecovery = (value: unknown): boolean =>
  !isRecord(value) || Object.keys(hydrateCollection(value)).length !== Object.keys(value).length;

/**
 * True when hydration repaired a count in a readable entry. Kept apart from collectionNeedsRecovery,
 * which also decides what a save file may hold: a file with a bad count is still refused (saveFile).
 */
export const collectionNeedsRepair = (value: unknown): boolean =>
  isRecord(value) && Object.values(value).some((item) => isRecord(item) && isReadableCard(item.card) && hasBadCount(item));

const read = (key: string): unknown => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
};

const write = (key: string, value: unknown): boolean => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`Migration could not write ${key}`, error);
    return false;
  }
};

type AnyRecord = Record<string, unknown>;

const migrateV2 = (): boolean => {
  const collection = read(STORAGE_KEYS.COLLECTION) as Record<string, unknown> | undefined;
  if (collection && typeof collection === 'object') {
    const next: Record<string, unknown> = {};
    const unreadable: [string, unknown][] = [];
    let repaired = false;
    for (const [oldKey, item] of Object.entries(collection)) {
      if (!isRecord(item)) {
        unreadable.push([oldKey, item]);
        continue;
      }
      const key = migrateCardKey(oldKey);
      const prev = next[key] as AnyRecord | undefined;
      let normal = Number(item.normalCount ?? item.count ?? 0);
      let holo = Number(item.holoCount ?? 0);
      if (!isCountOrNone(normal) || !isCountOrNone(holo)) {
        repaired = true;
        normal = isCountOrNone(normal) ? normal : repairCount(normal);
        holo = isCountOrNone(holo) ? holo : repairCount(holo);
      }
      next[key] = {
        card: hydrateCard({ ...(item.card as AnyRecord), id: String((item.card as AnyRecord)?.id ?? oldKey), key }),
        normalCount: Number(prev?.normalCount ?? 0) + normal,
        holoCount: Number(prev?.holoCount ?? 0) + holo,
      };
    }
    // Not card records, but still the player's data: keep each value as it was (under a free key if a
    // migrated card took its own), so hydration hides it and the next collection write archives it
    // for the private export (game/collectionRecovery.ts) instead of it vanishing here.
    for (const [oldKey, item] of unreadable) {
      let key = oldKey;
      while (key in next) key = `${key}#unreadable`;
      next[key] = item;
    }
    // A repaired count replaces the stored one, so keep the original bytes aside first (in this tab
    // only when storage is full). If they can't be read, write nothing: the stage is retried.
    if (repaired && keepUnreadableAside(STORAGE_KEYS.COLLECTION, () => true) === 'blocked') return false;
    if (!write(STORAGE_KEYS.COLLECTION, next)) return false;
  }

  const stats = read(STORAGE_KEYS.STATS) as AnyRecord | undefined;
  if (stats && typeof stats === 'object') {
    const holoCards = (stats.holoCards ?? {}) as Record<string, boolean>;
    stats.holoCards = Object.fromEntries(Object.keys(holoCards).map((id) => [migrateCardKey(id), true]));
    if (Array.isArray(stats.highestPackCards)) {
      const readable = stats.highestPackCards.filter(isReadablePackCard);
      const unreadable = stats.highestPackCards.filter((c) => !isReadablePackCard(c));
      if (unreadable.length > 0) {
        stats.highestPackCardsUnreadable = [
          ...(Array.isArray(stats.highestPackCardsUnreadable) ? stats.highestPackCardsUnreadable : []),
          ...unreadable,
        ];
      }
      if (readable.length > 0) {
        stats.highestPackCards = readable.map((c: AnyRecord) => hydrateCard({ ...c, id: String(c.id ?? c.key) }));
        if (!stats.highestPackProof) stats.highestPackLegacy = true;
      } else {
        stats.highestPackCards = [];
      }
    } else if (stats.highestPackCards !== undefined) {
      stats.highestPackCardsUnreadable = [
        ...(Array.isArray(stats.highestPackCardsUnreadable) ? stats.highestPackCardsUnreadable : []),
        stats.highestPackCards,
      ];
      delete stats.highestPackCards;
    }
    if (!write(STORAGE_KEYS.STATS, stats)) return false;
  }

  const achievements = read(STORAGE_KEYS.ACHIEVEMENTS) as Record<string, AnyRecord | number> | undefined;
  if (achievements && typeof achievements === 'object') {
    for (const value of Object.values(achievements)) {
      if (value && typeof value === 'object') {
        if (Array.isArray(value.pack)) {
          const readable = value.pack.filter(isReadablePackCard);
          const unreadable = value.pack.filter((c) => !isReadablePackCard(c));
          if (unreadable.length > 0) {
            value.unreadablePack = [
              ...(Array.isArray(value.unreadablePack) ? value.unreadablePack : []),
              ...unreadable,
            ];
          }
          if (readable.length > 0) {
            value.pack = readable.map((c: AnyRecord) => hydrateCard({ ...c, id: String(c.id ?? c.key) }));
          } else {
            value.pack = [];
          }
        } else if (value.pack !== undefined) {
          value.unreadablePack = [
            ...(Array.isArray(value.unreadablePack) ? value.unreadablePack : []),
            value.pack,
          ];
          delete value.pack;
        }
      }
    }
    if (!write(STORAGE_KEYS.ACHIEVEMENTS, achievements)) return false;
  }

  return true;
};

/**
 * v3: Buhcoins became Brainrot Score (card points x10, combo multipliers
 * matched to their odds). Recompute the stored best pack under the new rules.
 * A pack with unreadable entries can't be scored as a whole, so it keeps its legacy value.
 */
const migrateV3 = (): boolean => {
  const stats = read(STORAGE_KEYS.STATS) as AnyRecord | undefined;
  if (!stats || typeof stats !== 'object') return true;

  let changed = false;
  const setAside = (items: unknown[]) => {
    stats.highestPackCardsUnreadable = [
      ...(Array.isArray(stats.highestPackCardsUnreadable) ? stats.highestPackCardsUnreadable : []),
      ...items,
    ];
    changed = true;
  };
  // v2 (or an earlier run) may already have set entries of this pack aside.
  let partial = Array.isArray(stats.highestPackCardsUnreadable) && stats.highestPackCardsUnreadable.length > 0;

  if (Array.isArray(stats.highestPackCards) && stats.highestPackCards.length > 0) {
    const readable = stats.highestPackCards.filter(isReadablePackCard);
    const unreadable = stats.highestPackCards.filter((c) => !isReadablePackCard(c));
    if (unreadable.length > 0) {
      setAside(unreadable);
      stats.highestPackCards = readable;
      partial = true;
    } else if (!partial) {
      try {
        const cards = readable.map((c: AnyRecord) => ({ ...hydrateCard({ ...c, id: String(c.id ?? c.key) }), isHolo: !!c.isHolo }));
        const { points, hand, score } = scoreCards(cards);
        stats.highestPackCards = cards;
        stats.highestPackFlexValue = score;
        stats.highestPackBaseValue = points;
        stats.highestPackMultiplier = hand.multiplier;
        stats.highestPackHandName = hand.name;
        changed = true;
      } catch (error) {
        // Write nothing and keep the marker, so the next start retries this stage on the original fields.
        console.error('Migration could not score legacy best pack cards', error);
        return false;
      }
    }
  } else if (stats.highestPackCards !== undefined && !Array.isArray(stats.highestPackCards)) {
    setAside([stats.highestPackCards]);
    delete stats.highestPackCards;
    partial = true;
  }

  // The legacy value is the only score a partial pack has: drop it only when nothing was set aside.
  if (!partial && 'highestPackValue' in stats) {
    delete stats.highestPackValue;
    changed = true;
  }

  if (changed) {
    if (!write(STORAGE_KEYS.STATS, stats)) return false;
  }
  return true;
};

const SAVED_DATA_KEYS = [STORAGE_KEYS.COLLECTION, STORAGE_KEYS.STATS, STORAGE_KEYS.ACHIEVEMENTS];

/** The keys the migrations read and rewrite, with the version marker: what the recovery screen exports as stored. */
export const LEGACY_SAVE_KEYS = [...SAVED_DATA_KEYS, DATA_VERSION_KEY];

/**
 * The stored text of LEGACY_SAVE_KEYS, unparsed, as a JSON file for a player whose save couldn't be
 * upgraded. Only reads: it never changes storage.
 */
export const legacySaveFile = (now = new Date()): { name: string; text: string } => {
  const keys = Object.fromEntries(LEGACY_SAVE_KEYS.map((key) => {
    try {
      return [key, localStorage.getItem(key)];
    } catch {
      return [key, null];
    }
  }));
  return {
    name: `brainrot-tcg-save-before-upgrade-${now.toISOString().split('T')[0]}.json`,
    text: JSON.stringify({ exportedAt: now.toISOString(), keys }, null, 2),
  };
};

const hasSavedData = (): boolean => {
  try {
    return SAVED_DATA_KEYS.some((key) => localStorage.getItem(key) !== null);
  } catch {
    return false;
  }
};

/**
 * Upgrade stored data to CURRENT_DATA_VERSION. False only when there is saved data and a migration
 * write failed (usually full storage): the marker stays put so the stage is retried, and the game must
 * not start on that save. Storage that can't be read, or holds nothing to migrate, gives true: the game
 * starts as for a new player (player.ts keeps state in memory when storage is blocked).
 */
export const runMigrations = (): boolean => {
  let version: number;
  try {
    version = Number(localStorage.getItem(DATA_VERSION_KEY) ?? 1);
  } catch {
    return true;
  }
  if (!(version < CURRENT_VERSION)) return true;
  if (!hasSavedData()) {
    setDataVersion(CURRENT_VERSION);
    return true;
  }
  if (version < 2) {
    if (!migrateV2()) return false;
    if (!setDataVersion(2)) return false;
    version = 2;
  }
  if (version < 3) {
    if (!migrateV3()) return false;
    if (!setDataVersion(CURRENT_VERSION)) return false;
  }
  return true;
};
