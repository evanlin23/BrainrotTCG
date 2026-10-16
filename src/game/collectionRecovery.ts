import { STORAGE_KEYS } from '../constants';
import { collectionNeedsRecovery } from '../utils/migrations';
import { setStoredData } from '../utils/storage';

/** player.ts keeps its key private; the archive only snapshots the raw value. */
const PLAYER_KEY = 'brainrot-player-v1';
const ARCHIVE_KEY = STORAGE_KEYS.COLLECTION_RECOVERY;

export type CollectionSaveResult = 'saved' | 'recovered' | 'blocked';

/** One kept-aside collection: its exact bytes and the identity snapshot they belonged to. */
type Entry = { raw: string; player: string | null };
/**
 * The first payload kept, then the newest ones under `later`; `dropped` counts later payloads let go
 * to stay within the limits. `kind` marks a first entry that is an archive this code couldn't read.
 */
type Archive = Entry & { kind?: 'unparseable-archive'; later?: Entry[]; dropped?: number };

/** Later payloads kept beside the first; only a writer that keeps finding damage (an outdated tab) adds more. */
const LATER_LIMIT = 10;

/** Whole archive, in JSON.stringify characters: about a fifth of a typical 5M-character storage quota, so it can't crowd out the live save. */
export const ARCHIVE_BUDGET = 1_000_000;

/** Payloads this browser had no room to keep, held for this visit only so they can still be downloaded. */
let unsaved: Entry[] = [];
/** Older payloads let go from `unsaved` to stay within its limit (the stored archive counts its own in `dropped`). */
let droppedThisVisit = 0;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isEntry = (value: unknown): value is Entry => isRecord(value) && typeof value.raw === 'string'
  && (value.player === null || typeof value.player === 'string');

/** A stored archive this code can read; also what a backup file's collectionRecovery must be (saveFile). */
export const isArchive = (value: unknown): value is Archive => {
  if (!isEntry(value)) return false;
  const { later, dropped, kind } = value as Record<string, unknown>;
  return (later === undefined || (Array.isArray(later) && later.every(isEntry)))
    && (dropped === undefined || (Number.isSafeInteger(dropped) && (dropped as number) >= 0))
    && (kind === undefined || kind === 'unparseable-archive');
};

/** The stored archive, or its exact text wrapped as the first entry when it can't be read as one. */
const readArchive = (stored: string): Archive => {
  try {
    const archive: unknown = JSON.parse(stored);
    if (isArchive(archive)) return archive;
  } catch { /* Wrapped below. */ }
  return { raw: stored, player: null, kind: 'unparseable-archive' };
};

const entriesOf = (archive: Archive | null): Entry[] => (archive ? [archive, ...(archive.later ?? [])] : []);

const withLater = (first: Archive, later: Entry[], dropped: number): Archive => {
  const archive: Archive = { ...first, later, dropped };
  if (later.length === 0) delete archive.later;
  if (dropped === 0) delete archive.dropped;
  return archive;
};

/** Keep a payload storage couldn't take, for this visit; the note offers it as a download. */
const keepForThisVisit = (entry: Entry, why: unknown): 'archived' => {
  if (!unsaved.some((kept) => kept.raw === entry.raw)) {
    unsaved = [...unsaved, entry];
    // Same rule as the stored archive: the first and the newest, counting the one let go.
    if (unsaved.length > LATER_LIMIT + 1) {
      unsaved.splice(1, 1);
      droppedThisVisit++;
    }
  }
  console.warn('Unreadable collection data is kept in this tab only, because this browser had no room for it; download it before this tab closes or reloads.', why);
  return 'archived';
};

/**
 * Before the stored collection is replaced: if hydration hid any of its entries, keep its exact bytes
 * (with the identity they belonged to) aside. The archive never blocks the save: past its limits it
 * lets the oldest later payloads go, and when even the first and newest won't fit, it keeps the newest
 * for this visit. 'blocked' only means the stored collection couldn't be read, so it must stay.
 */
const archiveUnreadable = (): 'clean' | 'archived' | 'blocked' => {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEYS.COLLECTION);
  } catch (error) {
    console.error(`Failed to read localStorage key "${STORAGE_KEYS.COLLECTION}":`, error);
    return 'blocked';
  }
  if (raw === null) return 'clean';
  try {
    if (!collectionNeedsRecovery(JSON.parse(raw))) return 'clean';
  } catch { /* Unparseable bytes are unreadable too. */ }

  let player: string | null = null;
  let stored: string | null;
  try {
    player = localStorage.getItem(PLAYER_KEY);
    stored = localStorage.getItem(ARCHIVE_KEY);
  } catch (error) {
    return keepForThisVisit({ raw, player }, error);
  }
  const entry: Entry = { raw, player };
  const archive = stored === null ? null : readArchive(stored);
  if ([...entriesOf(archive), ...unsaved].some((kept) => kept.raw === raw)) return 'archived';
  if (archive?.kind === 'unparseable-archive') {
    console.warn(`"${ARCHIVE_KEY}" couldn't be read, so its exact text is kept as the first entry.`);
  }

  // The first payload keeps its place and identity snapshot; each different one goes under `later`.
  const first = archive ?? entry;
  let later = archive ? [...(archive.later ?? []), entry] : [];
  let evicted = 0;
  const text = () => JSON.stringify(withLater(first, later, (archive?.dropped ?? 0) + evicted));
  const evict = () => {
    later = later.slice(1);
    evicted++;
  };
  while (later.length > LATER_LIMIT) evict();
  while (later.length > 1 && text().length > ARCHIVE_BUDGET) evict();
  for (;;) {
    const value = text();
    if (value.length > ARCHIVE_BUDGET) return keepForThisVisit(entry, `${value.length} characters is over the ${ARCHIVE_BUDGET} budget`);
    try {
      localStorage.setItem(ARCHIVE_KEY, value);
      break;
    } catch (error) {
      // Full storage: let the oldest later payload go and try again, down to the first and the newest.
      if (later.length <= 1) return keepForThisVisit(entry, error);
      evict();
    }
  }
  if (evicted > 0) {
    console.warn(`Let the ${evicted} oldest later payload(s) go from "${ARCHIVE_KEY}" to keep the first and the newest within its limits.`);
  }
  return 'archived';
};

/**
 * Hydration may hide unreadable entries. Never let the next write silently erase them: keep their
 * original bytes aside first, then write the collection.
 */
export const persistCollection = (next: unknown): CollectionSaveResult => {
  const archive = archiveUnreadable();
  if (archive === 'blocked' || !setStoredData(STORAGE_KEYS.COLLECTION, next)) return 'blocked';
  return archive === 'archived' ? 'recovered' : 'saved';
};

/** 'stored': kept in this browser. 'unsaved': some of it lasts only for this visit, so download it now. */
export type CollectionRecoveryState = 'none' | 'stored' | 'unsaved';

const storedArchive = (): string | null => {
  try {
    return localStorage.getItem(ARCHIVE_KEY);
  } catch {
    return null;
  }
};

export const collectionRecoveryState = (): CollectionRecoveryState => {
  if (unsaved.length > 0) return 'unsaved';
  return storedArchive() === null ? 'none' : 'stored';
};

/** What the kept-aside note says, in the banner and in Settings > Save & backup (see collectionRecoveryNote). */
export const COLLECTION_RECOVERY_NOTES: Record<Exclude<CollectionRecoveryState, 'none'>, string> = {
  stored: "Unreadable collection data was kept aside in this browser. Download a copy, or discard it if you don't need it. Backups include it too.",
  unsaved: 'Unreadable collection data was kept aside, but this browser had no room to store it, so it lasts only until this tab closes or reloads. Download it now to keep it.',
};

/** Older payloads let go to stay within the limits: the stored archive's count plus this visit's. */
const droppedCount = (): number => {
  const stored = storedArchive();
  return (stored === null ? 0 : readArchive(stored).dropped ?? 0) + droppedThisVisit;
};

/** The kept-aside note as it is now, saying how many older payloads were let go; undefined when nothing is kept. */
export const collectionRecoveryNote = (): string | undefined => {
  const state = collectionRecoveryState();
  if (state === 'none') return undefined;
  const dropped = droppedCount();
  if (dropped === 0) return COLLECTION_RECOVERY_NOTES[state];
  return `${COLLECTION_RECOVERY_NOTES[state]} ${dropped} older unreadable ${dropped === 1 ? 'save was' : 'saves were'} let go to make room.`;
};

/** True when this browser holds kept-aside collection data (the stored archive is in the private export). */
export const hasCollectionRecovery = (): boolean => collectionRecoveryState() !== 'none';

/** Short and stable: the archive can be a whole collection, too big to copy just to compare. */
const fingerprint = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return `${value.length}:${(hash >>> 0).toString(36)}`;
};

/** The kept-aside data as it is now; the stored text alone keeps earlier dismissals valid. Throws if storage can't be read. */
const currentPrint = (): string | null => {
  const stored = localStorage.getItem(ARCHIVE_KEY);
  if (unsaved.length === 0) return stored === null ? null : fingerprint(stored);
  return fingerprint(`${stored ?? ''}\n${JSON.stringify(unsaved)}`);
};

/** The kept-aside data as it is now, to compare when the player confirms a discard; null when nothing is kept or storage can't be read. */
export const collectionRecoveryPrint = (): string | null => {
  try {
    return currentPrint();
  } catch {
    return null;
  }
};

/** The kept-aside data hidden during this visit, in case storage can't remember it (full storage). */
let hiddenThisVisit: string | null = null;

/** True when the player hid the kept-aside note for the data as it is now; anything newly kept brings it back. */
export const collectionRecoveryDismissed = (): boolean => {
  try {
    const print = currentPrint();
    if (print === null) return false;
    return print === hiddenThisVisit || localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN) === print;
  } catch {
    return false;
  }
};

/** Hide the kept-aside note for the current data. False when that can't be remembered past this visit. */
export const dismissCollectionRecovery = (): boolean => {
  try {
    const print = currentPrint();
    if (print === null) return false;
    hiddenThisVisit = print;
    localStorage.setItem(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN, print);
    return true;
  } catch {
    return false;
  }
};

/**
 * Everything kept aside, as a JSON file built in this browser: the stored archive (wrapped if it
 * can't be read) with this visit's unsaved payloads after it. Null when nothing is kept.
 */
export const collectionRecoveryFile = (now = new Date()): { name: string; text: string } | null => {
  const stored = storedArchive();
  const archive = stored === null ? null : readArchive(stored);
  const kept = entriesOf(archive);
  const extra = unsaved.filter((entry) => !kept.some((k) => k.raw === entry.raw));
  const dropped = (archive?.dropped ?? 0) + droppedThisVisit;
  let file: Archive;
  if (archive) file = extra.length === 0 && droppedThisVisit === 0 ? archive : withLater(archive, [...(archive.later ?? []), ...extra], dropped);
  else if (extra.length > 0) file = withLater(extra[0], extra.slice(1), dropped);
  else return null;
  return { name: `brainrot-collection-recovery-${now.toISOString().split('T')[0]}.json`, text: JSON.stringify(file, null, 2) };
};

/** Save the kept-aside data as a file; nothing leaves this browser. False when there's nothing to save. */
export const downloadCollectionRecovery = (): boolean => {
  const file = collectionRecoveryFile();
  if (!file) return false;
  const url = URL.createObjectURL(new Blob([file.text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
};

/** 'changed': the kept-aside data isn't what the player was shown, so nothing was removed. 'refused': storage wouldn't remove it. */
export type DiscardResult = 'discarded' | 'changed' | 'refused';

/**
 * Delete the kept-aside data for good, stored and unsaved, if it is still what the player was shown
 * (`shown`, from collectionRecoveryPrint when they were asked); this visit's copies go only once storage
 * has let go of the stored ones.
 */
export const discardCollectionRecovery = (shown: string | null): DiscardResult => {
  try {
    const print = currentPrint();
    if (print !== null && print !== shown) return 'changed';
    localStorage.removeItem(ARCHIVE_KEY);
  } catch (error) {
    console.error(`Failed to remove localStorage key "${ARCHIVE_KEY}":`, error);
    return 'refused';
  }
  // The data is gone either way: a dismissal left behind only matches the same data kept aside again.
  try {
    localStorage.removeItem(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN);
  } catch (error) {
    console.warn(`Failed to remove localStorage key "${STORAGE_KEYS.COLLECTION_RECOVERY_SEEN}":`, error);
  }
  unsaved = [];
  droppedThisVisit = 0;
  hiddenThisVisit = null;
  return 'discarded';
};
