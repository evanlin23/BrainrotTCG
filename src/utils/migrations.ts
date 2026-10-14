/**
 * One-time migrations of locally saved data. Runs before the app reads storage.
 *
 * v2: cards moved into sets with slug ids, and collections are keyed by
 * `${setId}/${cardId}`. Old saves used image file names as ids.
 */
import legacyGenesisIds from '../content/sets/genesis/legacy-ids.json';
import { CARD_RARITIES, getCard, scoreCards, type Card } from '../data/cards';
import { STORAGE_KEYS } from '../constants';

const DATA_VERSION_KEY = 'brainrot-data-version';
export const CURRENT_DATA_VERSION = 3;
const CURRENT_VERSION = CURRENT_DATA_VERSION;

/** After importing a save written by an older version: the next runMigrations() upgrades it. */
export const setDataVersion = (version: number) => {
  try {
    localStorage.setItem(DATA_VERSION_KEY, String(version));
  } catch {
    // storage unavailable
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

/** Refresh readable collection cards without rewriting the original saved payload. */
export function hydrateCollection<T extends { card: Partial<Card> & { id: string } }>(collection: Record<string, T>): Record<string, T & { card: Card }>;
export function hydrateCollection(collection: unknown): Record<string, { card: Card }>;
export function hydrateCollection(collection: unknown): Record<string, { card: Card }> {
  if (!isRecord(collection)) return {};
  const entries: [string, { card: Card }][] = [];
  for (const [key, item] of Object.entries(collection)) {
    if (isRecord(item) && isReadableCard(item.card)) {
      entries.push([key, { ...item, card: hydrateCard(item.card) }]);
    }
  }
  return Object.fromEntries(entries);
}

const read = (key: string): unknown => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
};

const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`Migration could not write ${key}`, error);
  }
};

type AnyRecord = Record<string, unknown>;

const migrateV2 = () => {
  const collection = read(STORAGE_KEYS.COLLECTION) as Record<string, AnyRecord> | undefined;
  if (collection && typeof collection === 'object') {
    const next: Record<string, AnyRecord> = {};
    for (const [oldKey, item] of Object.entries(collection)) {
      if (!item || typeof item !== 'object') continue;
      const key = migrateCardKey(oldKey);
      const prev = next[key];
      const normal = Number(item.normalCount ?? item.count ?? 0);
      const holo = Number(item.holoCount ?? 0);
      next[key] = {
        card: hydrateCard({ ...(item.card as AnyRecord), id: String((item.card as AnyRecord)?.id ?? oldKey), key }),
        normalCount: Number(prev?.normalCount ?? 0) + normal,
        holoCount: Number(prev?.holoCount ?? 0) + holo,
      };
    }
    write(STORAGE_KEYS.COLLECTION, next);
  }

  const stats = read(STORAGE_KEYS.STATS) as AnyRecord | undefined;
  if (stats && typeof stats === 'object') {
    const holoCards = (stats.holoCards ?? {}) as Record<string, boolean>;
    stats.holoCards = Object.fromEntries(Object.keys(holoCards).map((id) => [migrateCardKey(id), true]));
    if (Array.isArray(stats.highestPackCards)) {
      stats.highestPackCards = stats.highestPackCards.map((c: AnyRecord) => hydrateCard({ ...c, id: String(c.id) }));
    }
    // Pre-verification best packs can't be proven; keep them but mark them.
    if (stats.highestPackCards && !stats.highestPackProof) stats.highestPackLegacy = true;
    write(STORAGE_KEYS.STATS, stats);
  }

  const achievements = read(STORAGE_KEYS.ACHIEVEMENTS) as Record<string, AnyRecord | number> | undefined;
  if (achievements && typeof achievements === 'object') {
    for (const value of Object.values(achievements)) {
      if (value && typeof value === 'object' && Array.isArray(value.pack)) {
        value.pack = value.pack.map((c: AnyRecord) => hydrateCard({ ...c, id: String(c.id) }));
      }
    }
    write(STORAGE_KEYS.ACHIEVEMENTS, achievements);
  }
};

/**
 * v3: Buhcoins became Brainrot Score (card points x10, combo multipliers
 * matched to their odds). Recompute the stored best pack under the new rules.
 */
const migrateV3 = () => {
  const stats = read(STORAGE_KEYS.STATS) as AnyRecord | undefined;
  if (!stats || typeof stats !== 'object' || !Array.isArray(stats.highestPackCards) || stats.highestPackCards.length === 0) return;
  const cards = (stats.highestPackCards as AnyRecord[]).map((c) => ({ ...hydrateCard({ ...c, id: String(c.id) }), isHolo: !!c.isHolo }));
  const { points, hand, score } = scoreCards(cards);
  stats.highestPackFlexValue = score;
  stats.highestPackBaseValue = points;
  stats.highestPackMultiplier = hand.multiplier;
  stats.highestPackHandName = hand.name;
  delete stats.highestPackValue;
  write(STORAGE_KEYS.STATS, stats);
};

export const runMigrations = () => {
  let version = 1;
  try {
    version = Number(localStorage.getItem(DATA_VERSION_KEY) ?? 1);
  } catch {
    return;
  }
  if (version < 2) migrateV2();
  if (version < 3) migrateV3();
  try {
    localStorage.setItem(DATA_VERSION_KEY, String(CURRENT_VERSION));
  } catch {
    // storage unavailable; nothing to migrate next time either
  }
};
