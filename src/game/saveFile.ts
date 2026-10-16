/** Settings backup files: preflight every supplied field before changing browser storage. */
import { STORAGE_KEYS } from '../constants';
import { FINISH_MULTIPLIER, RARITIES_RAREST_FIRST, type Rarity } from '../engine';
import { getCard } from '../data/cards';
import { collectionNeedsRecovery, CURRENT_DATA_VERSION, DATA_VERSION_KEY, migrateCardKey } from '../utils/migrations';
import { isLegacyPull, isStored } from './history';
import { exportPlayer, importPlayer, isCurrentPlayer, parsePlayer } from './player';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === 'string';
const boolean = (value: unknown) => typeof value === 'boolean';
const optional = (value: RecordValue, key: string, valid: (v: unknown) => boolean) => !(key in value) || valid(value[key]);
const values = (value: unknown, valid: (v: unknown) => boolean) => record(value) && Object.values(value).every(valid);
const finish = (value: unknown) => text(value) && Object.prototype.hasOwnProperty.call(FINISH_MULTIPLIER, value);
const cards = (value: unknown) => Array.isArray(value) && value.every(card);
const card = (value: unknown): boolean => record(value) && text(value.id)
  && ['key', 'setId', 'name', 'image', 'caption', 'flavor'].every((key) => optional(value, key, text))
  && ['isHolo', 'isRevealed', 'misprint', 'isNew'].every((key) => optional(value, key, boolean))
  && (getCard(text(value.key) ? value.key : migrateCardKey(value.id)) !== undefined
    || (text(value.setId) && text(value.name) && text(value.image) && text(value.rarity)))
  && optional(value, 'rarity', (v) => text(v) && RARITIES_RAREST_FIRST.includes(v as Rarity))
  && optional(value, 'uniqueId', number) && optional(value, 'finish', (v) => v === null || finish(v));
const ref = (value: unknown) => record(value) && text(value.setId) && count(value.setVersion) && count(value.nonce)
  && optional(value, 'publicKeyHex', text);

const collectionEntry = (item: unknown) => record(item) && card(item.card)
  && ['normalCount', 'holoCount', 'count', 'misprints'].every((key) => optional(item, key, count))
  && optional(item, 'modifierPoints', number) && optional(item, 'finishes', (v) => values(v, count) && record(v) && Object.keys(v).every((key) => finish(key)));
const collection = (value: unknown) => values(value, collectionEntry);
const achievements = (value: unknown) => values(value, (item) => number(item) || (record(item) && number(item.unlockedAt)
  && optional(item, 'pack', cards) && optional(item, 'ref', ref)));
const stats = (value: unknown) => record(value) && optional(value, 'packsOpened', count)
  && optional(value, 'holoCards', (v) => values(v, boolean))
  && ['highestPackValue', 'highestPackFlexValue', 'highestPackBaseValue', 'highestPackMultiplier'].every((key) => optional(value, key, number))
  && optional(value, 'highestPackHandName', text) && optional(value, 'highestPackCards', cards)
  && optional(value, 'highestPackRef', ref) && optional(value, 'highestPackLegacy', boolean);
const hallOfFame = (value: unknown) => record(value)
  && ['first4OfAKind', 'firstFullHouse'].every((key) => optional(value, key, (v) => record(v)
    && boolean(v.achieved) && number(v.date) && optional(v, 'cardId', text) && optional(v, 'cards', (c) => values(c, count))));
const settings = (value: unknown) => record(value)
  && ['soundEnabled', 'particlesEnabled', 'pauseBigPulls', 'showDraftSets'].every((key) => optional(value, key, boolean))
  // readSettings clamps any finite slider value into 0..1, so accept what it can read.
  && ['musicVolume', 'effectsVolume'].every((key) => optional(value, key, (v) => typeof v === 'number' && Number.isFinite(v)))
  && ['cardBack', 'packFoil'].every((key) => optional(value, key, text));
// Same rule as recordPack: an entry it would refuse must never be imported, or every later pack write fails.
// Stricter here only: no build stores a negative score or opening time, but a stored one mustn't block writes.
const history = (value: unknown) => Array.isArray(value) && value.every((entry) => isStored(entry) && number(entry.x) && number(entry.t));
// Same rule as migratePullLog, which would otherwise keep an imported log it can never carry over.
const pulls = (value: unknown) => Array.isArray(value) && value.every((entry) => isLegacyPull(entry) && ref(entry)
  && number(entry.score) && number(entry.openedAt));

/** One kept-aside collection: its exact bytes and the identity snapshot they belonged to. */
const archived = (value: unknown): value is RecordValue => record(value) && text(value.raw)
  && (value.player === null || text(value.player));

const SAVE_FIELDS = [
  ['collection', STORAGE_KEYS.COLLECTION, collection],
  ['collectionRecovery', STORAGE_KEYS.COLLECTION_RECOVERY, (value: unknown) => archived(value)
    && optional(value, 'later', (later) => Array.isArray(later) && later.every(archived))],
  ['achievements', STORAGE_KEYS.ACHIEVEMENTS, achievements],
  ['stats', STORAGE_KEYS.STATS, stats],
  ['hallOfFame', STORAGE_KEYS.HALL_OF_FAME, hallOfFame],
  ['pulls', STORAGE_KEYS.PULLS, pulls],
  ['history', STORAGE_KEYS.HISTORY, history],
  ['settings', STORAGE_KEYS.SETTINGS, settings],
] as const;

/**
 * A raw storage value handed over by the old address (move.ts), held to the same rules as a file field,
 * except for what that address's own storage keeps on purpose: migrateV2 takes any first-format
 * collection entry (a missing card comes from its key) and any holoCards value, and stores a count it
 * can't read as NaN, which JSON writes as null and the app counts as 0. Hydration leaves out a later
 * entry it can't read, which collectionRecovery archives, or keeps in place when it can't. The old
 * address only redirects, so refusing those would leave the save with nowhere to go.
 */
export const isValidSaveValue = (key: string, raw: string, dataVersion: number): boolean => {
  const field = SAVE_FIELDS.find(([, storageKey]) => storageKey === key);
  if (!field) return true;
  try {
    const value: unknown = JSON.parse(raw);
    if (key === STORAGE_KEYS.COLLECTION) {
      return values(value, (item) => dataVersion < 2 || collectionNeedsRecovery({ item }) || (record(item) && collectionEntry(
        Object.fromEntries(Object.entries(item).filter(([k, v]) => !(v === null && (k === 'normalCount' || k === 'holoCount')))))));
    }
    if (key === STORAGE_KEYS.STATS && dataVersion < 2 && record(value)) return stats({ ...value, holoCards: {} });
    return field[2](value);
  } catch {
    return false;
  }
};

/** Keep this browser's save under `backupKey` before something replaces it (an imported file, a move). */
export const backUpSave = (backupKey: string): boolean => {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))
      .filter((key): key is string => !!key?.startsWith('brainrot-') && !key.startsWith('brainrot-before-'));
    if (keys.length === 0) return true;
    const backup = Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)]));
    localStorage.setItem(backupKey, JSON.stringify(backup));
    return true;
  } catch {
    return false;
  }
};

/** How importSaveFile's message starts when a failed import couldn't be undone (the page then reloads). */
export const PARTIAL_IMPORT_NOTE = "Import failed partway and couldn't be fully undone, so this browser may now hold parts of both saves.";

/** Private backup: recovery payloads remain opaque, separate from the active identity/state. */
export const exportSaveFile = (): string => JSON.stringify({
  ...Object.fromEntries(SAVE_FIELDS.map(([field, key]) => [field, localStorage.getItem(key)])),
  player: exportPlayer(),
  exportedAt: new Date().toISOString(),
  version: 2,
  dataVersion: CURRENT_DATA_VERSION,
}, null, 2);

/** Belong to one player; settings are this device's preferences. */
const PLAYER_FIELDS = new Set<string>(SAVE_FIELDS.map(([, key]) => key).filter((key) => key !== STORAGE_KEYS.SETTINGS));

/** Remove imported values before restoring originals, so rollback does not need both copies' space. */
const restoreFields = (changed: string[], previous: Map<string, string | null>): boolean => {
  for (const key of changed) {
    try { localStorage.removeItem(key); } catch { /* Still try restoring the old value. */ }
  }
  for (const key of changed) {
    const value = previous.get(key);
    if (value !== null && value !== undefined) {
      try { localStorage.setItem(key, value); } catch { /* Verify the final state below. */ }
    }
  }
  return changed.every((key) => {
    try { return localStorage.getItem(key) === previous.get(key); } catch { return false; }
  });
};

/**
 * Omitted/null fields preserve existing storage, as older exports omitted fields introduced later,
 * unless the save brings a different player: then this browser's player data (recovery archive
 * included) moves to the import backup instead of staying under the new identity.
 * This validates structure, not the authenticity of cached cards/scores, and is not an atomic commit.
 */
export const importSaveFile = (raw: string): string | null => {
  try {
    const save: unknown = JSON.parse(raw);
    if (!record(save) || (save.version !== 1 && save.version !== 2)
      || !text(save.exportedAt) || !Number.isFinite(Date.parse(save.exportedAt))) {
      return "That file isn't a supported Brainrot TCG save.";
    }
    const dataVersion = save.dataVersion === undefined ? (save.version === 1 ? 1 : CURRENT_DATA_VERSION) : save.dataVersion;
    if (!count(dataVersion) || dataVersion < 1 || dataVersion > CURRENT_DATA_VERSION) {
      return 'This save uses an unsupported data version.';
    }
    const staged: [string, string | null][] = [];
    const omitted: string[] = [];
    for (const [field, key, valid] of SAVE_FIELDS) {
      const fieldValue = save[field];
      if (fieldValue === undefined || fieldValue === null) {
        omitted.push(key);
        continue;
      }
      if (typeof fieldValue !== 'string' || !valid(JSON.parse(fieldValue))) {
        return `The ${field} in this save is invalid. Nothing was imported.`;
      }
      staged.push([key, fieldValue]);
    }
    const incomingPlayer = save.player === undefined || save.player === null ? null
      : typeof save.player === 'string' ? parsePlayer(save.player) : null;
    if (save.player !== undefined && save.player !== null && !incomingPlayer) {
      return 'The player identity in this save is invalid. Nothing was imported.';
    }
    // Cleared first, which also frees space for the imported fields.
    if (incomingPlayer && !isCurrentPlayer(incomingPlayer.secretKey)) {
      staged.unshift(...omitted.filter((key) => PLAYER_FIELDS.has(key)).map((key): [string, null] => [key, null]));
    }
    // Capture originals before even the backup write. Other null/omitted fields remain untouched.
    staged.push([DATA_VERSION_KEY, String(dataVersion)]);
    const previous = new Map(staged.map(([key]) => [key, localStorage.getItem(key)]));
    if (!backUpSave('brainrot-before-import-v1')) {
      return "Couldn't keep a backup of your current save. Nothing was imported.";
    }
    const changed: string[] = [];
    try {
      for (const [key, value] of staged) {
        if (previous.get(key) === value) continue;
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
        changed.push(key);
      }
      // Identity is last: no later write can fail after importPlayer adopts the new memory identity.
      if (typeof save.player === 'string' && !importPlayer(save.player)) throw new Error('Identity import failed');
    } catch {
      if (restoreFields(changed, previous)) return 'Import failed. Your previous save data was restored.';
      // backUpSave copied every app key, so any value here means a copy was just made.
      const backedUp = [...previous.values()].some((value) => value !== null);
      return PARTIAL_IMPORT_NOTE + (backedUp ? ' A copy of the save from before the import is kept in this browser.' : '');
    }
    return null;
  } catch {
    return "Couldn't read or store that file. Is it a save exported from Save & backup?";
  }
};
