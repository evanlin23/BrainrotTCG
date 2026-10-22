/** Settings backup files: preflight every supplied field before changing browser storage. */
import { STORAGE_KEYS } from '../constants';
import { FINISH_MULTIPLIER, RARITIES_RAREST_FIRST, type Rarity } from '../engine';
import { getCard } from '../data/cards';
import { collectionNeedsRecovery, CURRENT_DATA_VERSION, DATA_VERSION_KEY, migrateCardKey } from '../utils/migrations';
import { isArchive } from './collectionRecovery';
import { isBestCardsStore, resetBestCards } from './bestCards';
import { isLegacyPull, isStored, withReadableCache } from './history';
import { exportPlayer, importPlayer, isCurrentPlayer, newSaveStamp, parsePlayer, SAVE_STAMP_KEY, sameSave, saveMark, type SaveMark } from './player';

export const STALE_SAVE_WARNING = "This save changed in another tab, so this tab can't open packs or save anything now. Reload to continue with that save.";

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
  && ['soundEnabled', 'particlesEnabled', 'pauseBigPulls', 'showDraftSets', 'showAllPages'].every((key) => optional(value, key, boolean))
  // readSettings clamps any finite slider value into 0..1, so accept what it can read. musicVolume is the
  // removed music slider: older saves still carry it and readSettings drops it.
  && ['musicVolume', 'effectsVolume'].every((key) => optional(value, key, (v) => typeof v === 'number' && Number.isFinite(v)))
  && ['cardBack', 'packFoil'].every((key) => optional(value, key, text));
// Same rule as recordPack: an entry it would refuse must never be imported, or every later pack write fails.
// Stricter here only: no build stores a negative score or opening time, but a stored one mustn't block writes.
const history = (value: unknown) => Array.isArray(value) && value.every((entry) => isStored(entry) && number(entry.x) && number(entry.t));
// Same rule as migratePullLog, which would otherwise keep an imported log it can never carry over.
const pulls = (value: unknown) => Array.isArray(value) && value.every((entry) => isLegacyPull(entry) && ref(entry)
  && number(entry.score) && number(entry.openedAt));

/**
 * A best-pack card in a save older than v3, read as its readers read it: migrateV2 stores
 * hydrateCard({ ...c, id: String(c.id) }), migrateV3 scores that with `!!c.isHolo`, and the profile
 * hydrates it again, so a known card's stored display fields give way to the registry's. Before v2 a
 * numeric id is fine (migrateV2 stores it as text); after, the profile reads the id as stored.
 */
const olderBestCard = (value: unknown, dataVersion: number) => {
  if (!record(value) || !(text(value.id) || (dataVersion < 2 && number(value.id)))) return false;
  // `!!c.isHolo` reads null as no holo, but any other non-boolean is a bad field, as in a file.
  if (!optional(value, 'isHolo', (v) => v === null || boolean(v))) return false;
  const id = String(value.id);
  const lookup = value.key ?? migrateCardKey(id);
  const read = { ...value, id, isHolo: !!value.isHolo, ...(text(lookup) ? getCard(lookup) : undefined) };
  // JSON drops what the registry leaves undefined (a card without a caption clears a stored one).
  return card(Object.fromEntries(Object.entries(read).filter(([, v]) => v !== undefined)));
};

const SAVE_FIELDS = [
  ['collection', STORAGE_KEYS.COLLECTION, collection],
  // The archive's own rule: exact bytes and identity snapshots, `later`, `dropped` and `kind` included.
  ['collectionRecovery', STORAGE_KEYS.COLLECTION_RECOVERY, isArchive],
  ['achievements', STORAGE_KEYS.ACHIEVEMENTS, achievements],
  ['stats', STORAGE_KEYS.STATS, stats],
  ['hallOfFame', STORAGE_KEYS.HALL_OF_FAME, hallOfFame],
  ['pulls', STORAGE_KEYS.PULLS, pulls],
  ['history', STORAGE_KEYS.HISTORY, history],
  ['bestCards', STORAGE_KEYS.BEST_CARDS, isBestCardsStore],
  ['settings', STORAGE_KEYS.SETTINGS, settings],
] as const;

/**
 * A raw storage value handed over by the old address (move.ts), held to the same rules as a file field,
 * except for what that address's own storage keeps on purpose: migrateV2 takes any first-format
 * collection entry (a missing card comes from its key) and any holoCards value, and stores a count it
 * can't read as NaN, which JSON writes as null and the app counts as 0. Before v3, best-pack cards
 * are checked as their readers take them (olderBestCard). Hydration leaves out a later
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
    if (key === STORAGE_KEYS.STATS && dataVersion < 3 && record(value)) {
      const best = value.highestPackCards;
      return stats({ ...value, ...(dataVersion < 2 && { holoCards: {} }), highestPackCards: [] }) && (!('highestPackCards' in value)
        || (Array.isArray(best) && best.every((c) => olderBestCard(c, dataVersion))));
    }
    return field[2](value);
  } catch {
    return false;
  }
};

/** A full browser storage (Chrome/Safari, Firefox). */
export const isQuotaError = (e: unknown): boolean => e instanceof DOMException
  && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');

/** Keep this browser's save under `backupKey` before something replaces it (an imported file, a move). */
export const backUpSave = (backupKey: string): boolean => {
  try {
    const copy = saveCopy();
    if (copy !== null) localStorage.setItem(backupKey, copy);
    return true;
  } catch {
    return false;
  }
};

/** Every app key except earlier copies, as backUpSave stores it; null when there is nothing to copy. */
const saveCopy = (): string | null => {
  const keys = storedKeys().filter((key) => key.startsWith('brainrot-') && !key.startsWith(COPY_PREFIX));
  return keys.length === 0 ? null : JSON.stringify(Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])));
};
const COPY_PREFIX = 'brainrot-before-';
const storedKeys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => !!key);
/** Room a stored value takes, counted as browsers count it against the quota (key and value characters). */
const room = (key: string, value: string | null | undefined) => (value === null || value === undefined ? 0 : key.length + value.length);
const roomUsed = () => storedKeys().reduce((sum, key) => sum + room(key, localStorage.getItem(key)), 0);

/** How importSaveFile's message starts when a failed import couldn't be undone (the page then reloads). */
export const PARTIAL_IMPORT_NOTE = "Import failed partway and couldn't be fully undone, so this browser may now hold parts of both saves.";

/** importSaveFile's answer when the file may fit, but not beside a copy of this save: nothing changed, and Settings offers to go on without one. */
export const NO_ROOM_FOR_COPY_NOTE = "There's no room in this browser's storage for this file and a copy of your current save."
  + ' Nothing changed. Export your save first if you want to keep it, then replace it without a copy.';

/**
 * importSaveFile's answer when the file alone needs more room than this browser's storage has, followed
 * by COPIES_NOTE when copies of earlier saves take some of that room.
 */
export const FILE_TOO_BIG_NOTE = "This file is too big for this browser's storage, so it can't be imported here. Nothing changed.";

export const NO_ROOM_NOTE = "This browser's storage has no room for this file. Your previous save data was restored.";

/** Added to a no-room answer while copies of earlier saves (brainrot-before-*) take room too. */
export const COPIES_NOTE = ' Copies of earlier saves, kept from past imports or moves, take room in it too.';

/** importSaveFile's answer when a copy of this save couldn't be written for a reason other than full storage. */
export const NO_COPY_NOTE = "Couldn't keep a backup of your current save. Nothing was imported.";

const IMPORT_BACKUP_KEY = 'brainrot-before-import-v1';

/** Private backup: recovery payloads remain opaque, separate from the active identity/state. */
export const exportSaveFile = (): string => JSON.stringify({
  // History as this app reads it, so the file imports again (#652): its unreadable cached codes are dropped.
  ...Object.fromEntries(SAVE_FIELDS.map(([field, key]) => [field,
    key === STORAGE_KEYS.HISTORY ? withReadableCache(localStorage.getItem(key)) : localStorage.getItem(key)])),
  player: exportPlayer(),
  exportedAt: new Date().toISOString(),
  version: 2,
  dataVersion: CURRENT_DATA_VERSION,
}, null, 2);

/** Download a save file (by default this browser's save, as exportSaveFile writes it). */
export const downloadSaveFile = (content = exportSaveFile()) => {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `brainrot-tcg-save-${new Date().toISOString().split('T')[0]}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

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
 * Each replaced value is removed before the new ones are written, so the old and new saves never need
 * room at once. When storage fills, nothing changes: if the file can't fit even without a copy of this save
 * the answer is FILE_TOO_BIG_NOTE, otherwise NO_ROOM_FOR_COPY_NOTE, and `keepCopy: false` (the player's
 * choice after that) then imports without one. Either answer names copies of earlier saves when they take room.
 * A copy refused for another reason is NO_COPY_NOTE: no room was shown to be missing, so no offer to go on.
 * This validates structure, not the authenticity of cached cards/scores, and is not an atomic commit.
 */
export const importSaveFile = (raw: string, { keepCopy = true, expectedSave }: { keepCopy?: boolean; expectedSave?: SaveMark } = {}): string | null => {
  if (expectedSave && !sameSave(expectedSave, saveMark())) {
    return STALE_SAVE_WARNING;
  }
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
    // Capture originals before even the backup write. Other null/omitted fields remain untouched.
    staged.push([DATA_VERSION_KEY, String(dataVersion)]);
    // The stamp goes before any imported value, so another tab still on the old save stops writing it
    // (see saveMark). A different player's fields are cleared before it, which frees space for it and
    // the imported fields, and again after it, in case such a tab wrote one in between: clears always
    // run, even for a field that was absent when `previous` was captured.
    const clears = incomingPlayer && !isCurrentPlayer(incomingPlayer.secretKey)
      ? omitted.filter((key) => PLAYER_FIELDS.has(key)).map((key): [string, null] => [key, null]) : [];
    staged.unshift(...clears, [SAVE_STAMP_KEY, newSaveStamp()], ...clears);
    const previous = new Map(staged.map(([key]) => [key, localStorage.getItem(key)]));
    // After the stamp, every value the file replaces is removed before any is written: the old save's
    // copies of them stop taking room the file needs (the import fits if the file does, copy aside).
    const stamp = staged.findIndex(([key]) => key === SAVE_STAMP_KEY) + 1 + clears.length;
    staged.splice(stamp, 0, ...staged.slice(stamp)
      .filter(([key, value]) => value !== null && previous.get(key) !== null && previous.get(key) !== value)
      .map(([key]): [string, null] => [key, null]));
    // A refused write proves storage holds less than `limit`. If this save with the file's values in place
    // (no new copy, earlier ones kept) would take at least that, the file can never fit here.
    let limit = Infinity;
    const refused = (key: string, value: string) => { limit = roomUsed() - room(key, localStorage.getItem(key)) + room(key, value); };
    const fileCantFit = () => {
      const after = new Map(staged);
      return roomUsed() + [...after].reduce((sum, [key, value]) => sum + room(key, value) - room(key, previous.get(key)), 0) >= limit;
    };
    const copiesNote = () => (storedKeys().some((key) => key.startsWith(COPY_PREFIX)) ? COPIES_NOTE : '');
    const noRoom = () => NO_ROOM_NOTE + copiesNote();
    const tooBig = () => FILE_TOO_BIG_NOTE + copiesNote();
    const earlierCopy = localStorage.getItem(IMPORT_BACKUP_KEY);
    const copy = keepCopy ? saveCopy() : null;
    if (copy !== null) {
      try {
        localStorage.setItem(IMPORT_BACKUP_KEY, copy);
      } catch (error) {
        if (!isQuotaError(error)) return NO_COPY_NOTE;
        refused(IMPORT_BACKUP_KEY, copy);
        return fileCantFit() ? tooBig() : NO_ROOM_FOR_COPY_NOTE;
      }
    }
    const changed: string[] = [];
    try {
      for (const [key, value] of staged) {
        if (value !== null && previous.get(key) === value) continue;
        if (value === null) localStorage.removeItem(key);
        else {
          try { localStorage.setItem(key, value); } catch (error) {
            if (isQuotaError(error)) refused(key, value);
            throw error;
          }
        }
        if (!changed.includes(key)) changed.push(key);
      }
      // Identity is last: no later write can fail after importPlayer adopts the new memory identity.
      let identityError: unknown = new Error('Identity import failed');
      if (typeof save.player === 'string' && !importPlayer(save.player, (error) => { identityError = error; })) throw identityError;
    } catch (error) {
      if (restoreFields(changed, previous)) {
        if (!isQuotaError(error)) return 'Import failed. Your previous save data was restored.';
        if (copy === null) return fileCantFit() ? tooBig() : noRoom();
        // The copy took room the file needed. The save it copied is back in place, so put back the earlier copy.
        try {
          if (earlierCopy === null) localStorage.removeItem(IMPORT_BACKUP_KEY);
          else localStorage.setItem(IMPORT_BACKUP_KEY, earlierCopy);
        } catch { /* The new copy stays: it holds the same save. */ }
        return fileCantFit() ? tooBig() : NO_ROOM_FOR_COPY_NOTE;
      }
      return PARTIAL_IMPORT_NOTE + (copy !== null ? ' A copy of the save from before the import is kept in this browser.' : '');
    }
    // A list this tab couldn't store belongs to the save just replaced: never write it into this one.
    resetBestCards();
    return null;
  } catch {
    return "Couldn't read or store that file. Is it a save exported from Save & backup?";
  }
};
