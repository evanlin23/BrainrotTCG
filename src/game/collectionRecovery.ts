import { STORAGE_KEYS } from '../constants';
import { collectionNeedsRecovery } from '../utils/migrations';
import { setStoredData } from '../utils/storage';

/** player.ts keeps its key private; the archive only snapshots the raw value. */
const PLAYER_KEY = 'brainrot-player-v1';

export type CollectionSaveResult = 'saved' | 'recovered' | 'blocked';

/** True when this browser holds an archived unreadable collection (offered in the private export). */
export const hasCollectionRecovery = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY) !== null;
  } catch {
    return false;
  }
};

/** Short and stable: the archive can be a whole collection, too big to copy just to compare. */
const fingerprint = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return `${value.length}:${(hash >>> 0).toString(36)}`;
};

/** The archive hidden during this visit, in case storage can't remember it (full storage). */
let hiddenThisVisit: string | null = null;

/** True when the player hid the kept-aside note for the archive as it is now; anything newly kept brings it back. */
export const collectionRecoveryDismissed = (): boolean => {
  try {
    const archive = localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY);
    if (archive === null) return false;
    const print = fingerprint(archive);
    return print === hiddenThisVisit || localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN) === print;
  } catch {
    return false;
  }
};

/** Hide the kept-aside note for the current archive. False when that can't be remembered past this visit. */
export const dismissCollectionRecovery = (): boolean => {
  try {
    const archive = localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY);
    if (archive === null) return false;
    hiddenThisVisit = fingerprint(archive);
    localStorage.setItem(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN, hiddenThisVisit);
    return true;
  } catch {
    return false;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Before the stored collection is replaced: if hydration hid any of its entries, keep its exact
 * bytes (with the identity they belonged to) in the archive. 'blocked' means it must not be replaced.
 */
const archiveUnreadable = (): 'clean' | 'archived' | 'blocked' => {
  const key = STORAGE_KEYS.COLLECTION_RECOVERY;
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.COLLECTION);
    if (raw === null) return 'clean';
    try {
      if (!collectionNeedsRecovery(JSON.parse(raw))) return 'clean';
    } catch { /* Unparseable bytes are unreadable too. */ }
    const entry = { raw, player: localStorage.getItem(PLAYER_KEY) };
    const previous = localStorage.getItem(key);
    if (previous === null) {
      localStorage.setItem(key, JSON.stringify(entry));
      return 'archived';
    }
    // The first archived payload keeps its place and identity snapshot; each different damaged
    // payload after it goes under `later`, so none replaces another and saving can go on.
    let archive: unknown;
    try {
      archive = JSON.parse(previous);
    } catch { /* Checked below. */ }
    if (!isRecord(archive) || (archive.later !== undefined && !Array.isArray(archive.later))) {
      console.error(`Kept the stored collection: "${key}" can't be read, so another unreadable collection can't be added to it.`);
      return 'blocked';
    }
    const later: unknown[] = archive.later ?? [];
    if ([archive, ...later].some((kept) => isRecord(kept) && kept.raw === raw)) return 'archived';
    localStorage.setItem(key, JSON.stringify({ ...archive, later: [...later, entry] }));
    return 'archived';
  } catch (error) {
    // Reads and the archive write can be denied independently; keep the stored collection.
    console.error(`Failed to save to localStorage key "${key}":`, error);
    return 'blocked';
  }
};

/**
 * Hydration may hide unreadable entries. Never let the next write silently erase them: archive
 * their original bytes for the private export first, then write the collection.
 */
export const persistCollection = (next: unknown): CollectionSaveResult => {
  const archive = archiveUnreadable();
  if (archive === 'blocked' || !setStoredData(STORAGE_KEYS.COLLECTION, next)) return 'blocked';
  return archive === 'archived' ? 'recovered' : 'saved';
};
