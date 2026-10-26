import { STORAGE_KEYS } from '../constants';
import { collectionNeedsRecovery } from '../utils/migrations';
import { setStoredData } from '../utils/storage';

/** player.ts keeps its key private; the archive only snapshots the raw value. */
const PLAYER_KEY = 'brainrot-player-v1';
const ARCHIVE_KEY = STORAGE_KEYS.COLLECTION_RECOVERY;

export type CollectionSaveResult = 'saved' | 'recovered' | 'blocked';

/** Stats kept aside are marked with their storage key (game/statsRecovery.ts); an entry without one is a collection. */
const STATS_KEY = STORAGE_KEYS.STATS;

/** Player records (game/player.ts) and stats kept aside are marked with their storage key; an entry without one is a collection. */
type KeptKey = typeof PLAYER_KEY | typeof STATS_KEY;

/** One kept-aside collection (or player record, or stats): its exact bytes and the identity snapshot they belonged to. */
type Entry = { raw: string; player: string | null; key?: KeptKey };
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
/** Stored bytes the player discarded the kept-aside copy of this visit: the next write replaces them without keeping them again. */
let discarded: Entry[] = [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isEntry = (value: unknown): value is Entry => isRecord(value) && typeof value.raw === 'string'
  && (value.player === null || typeof value.player === 'string')
  && (value.key === undefined || value.key === PLAYER_KEY || value.key === STATS_KEY);

const sameEntry = (a: Entry, b: Entry) => a.raw === b.raw && a.key === b.key;

/** A stored archive this code can read; also what a backup file's collectionRecovery must be (saveFile). */
export const isArchive = (value: unknown): value is Archive => {
  if (!isEntry(value)) return false;
  const { later, dropped, kind } = value as Record<string, unknown>;
  if (
    !(later === undefined || (Array.isArray(later) && later.every(isEntry)))
    || !(dropped === undefined || (Number.isSafeInteger(dropped) && (dropped as number) >= 0))
    || !(kind === undefined || kind === 'unparseable-archive')
  ) {
    return false;
  }
  try {
    return JSON.stringify(value).length <= ARCHIVE_BUDGET;
  } catch {
    return false;
  }
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

const withKey = (entry: Entry, storageKey: string): Entry =>
  (storageKey === PLAYER_KEY || storageKey === STATS_KEY ? { ...entry, key: storageKey } : entry);

const WHAT: Record<KeptKey | 'collection', string> = {
  collection: 'collection data is', [PLAYER_KEY]: 'player data is', [STATS_KEY]: 'stats are',
};

const withLater = (first: Archive, later: Entry[], dropped: number): Archive => {
  const archive: Archive = { ...first, later, dropped };
  if (later.length === 0) delete archive.later;
  if (dropped === 0) delete archive.dropped;
  return archive;
};

/** Keep a payload storage couldn't take, for this visit; the note offers it as a download. */
const keepForThisVisit = (entry: Entry, why: unknown): 'archived' => {
  if (!unsaved.some((kept) => sameEntry(kept, entry))) {
    unsaved = [...unsaved, entry];
    // Same rule as the stored archive: the first and the newest, counting the one let go.
    if (unsaved.length > LATER_LIMIT + 1) {
      unsaved.splice(1, 1);
      droppedThisVisit++;
    }
  }
  console.warn(`Unreadable ${WHAT[entry.key ?? 'collection']} kept in this tab only, because this browser had no room for it; download it before this tab closes or reloads.`, why);
  return 'archived';
};

/**
 * Before the stored collection (or player record, or stats) is replaced: if `unreadable` says this build can't read all of
 * it, keep its exact bytes (with the identity they belonged to) aside. The archive never blocks the save:
 * past its limits it lets the oldest later payloads go, and when even the first and newest won't fit, it
 * keeps the newest for this visit. 'blocked' only means the stored value couldn't be read, so it must stay.
 */
export const keepUnreadableAside = (
  storageKey: typeof STORAGE_KEYS.COLLECTION | KeptKey,
  unreadable: (raw: string) => boolean,
): 'clean' | 'archived' | 'blocked' => {
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey);
  } catch (error) {
    console.error(`Failed to read localStorage key "${storageKey}":`, error);
    return 'blocked';
  }
  if (raw === null || !unreadable(raw)) return 'clean';
  if (discarded.some((gone) => sameEntry(gone, withKey({ raw, player: null }, storageKey)))) return 'clean';

  let player: string | null = null;
  let stored: string | null;
  try {
    player = localStorage.getItem(PLAYER_KEY);
    stored = localStorage.getItem(ARCHIVE_KEY);
  } catch (error) {
    return keepForThisVisit(withKey({ raw, player }, storageKey), error);
  }
  const entry = withKey({ raw, player }, storageKey);
  const archive = stored === null ? null : readArchive(stored);
  if ([...entriesOf(archive), ...unsaved].some((kept) => sameEntry(kept, entry))) return 'archived';
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

/** True when the bytes stored under this key are in the stored archive, not only kept for this visit. */
export const keptInStorage = (storageKey: typeof STORAGE_KEYS.COLLECTION | KeptKey): boolean => {
  try {
    const raw = localStorage.getItem(storageKey);
    const stored = localStorage.getItem(ARCHIVE_KEY);
    if (raw === null || stored === null) return false;
    const entry = withKey({ raw, player: null }, storageKey);
    return entriesOf(readArchive(stored)).some((kept) => sameEntry(kept, entry));
  } catch {
    return false;
  }
};

/** Unparseable bytes are unreadable too. */
const collectionUnreadable = (raw: string): boolean => {
  try {
    return collectionNeedsRecovery(JSON.parse(raw));
  } catch {
    return true;
  }
};

/**
 * Hydration may hide unreadable entries. Never let the next write silently erase them: keep their
 * original bytes aside first, then write the collection.
 */
export const persistCollection = (next: unknown): CollectionSaveResult => {
  const archive = keepUnreadableAside(STORAGE_KEYS.COLLECTION, collectionUnreadable);
  if (archive === 'blocked' || !setStoredData(STORAGE_KEYS.COLLECTION, next)) return 'blocked';
  return archive === 'archived' ? 'recovered' : 'saved';
};

/**
 * 'stored': kept in this browser. 'unsaved': some of it lasts only for this visit, so download it now.
 * 'unavailable': storage refused to read the archive, so whether anything is kept there is unknown.
 */
export type CollectionRecoveryState = 'none' | 'stored' | 'unsaved' | 'unavailable';

type StoredArchive =
  | { status: 'found'; raw: string }
  | { status: 'none' }
  | { status: 'unavailable'; error: unknown };

const getStoredArchive = (): StoredArchive => {
  try {
    const raw = localStorage.getItem(ARCHIVE_KEY);
    return raw === null ? { status: 'none' } : { status: 'found', raw };
  } catch (error) {
    return { status: 'unavailable', error };
  }
};

export const collectionRecoveryState = (): CollectionRecoveryState => {
  if (unsaved.length > 0) return 'unsaved';
  const stored = getStoredArchive();
  if (stored.status === 'unavailable') return 'unavailable';
  return stored.status === 'none' ? 'none' : 'stored';
};

type KeptState = Exclude<CollectionRecoveryState, 'none' | 'unavailable'>;
const KEPT: Record<KeptState, string> = {
  stored: "was kept aside in this browser. Download a copy, or discard it if you don't need it. Backups include it too.",
  unsaved: 'was kept aside, but this browser had no room to store it, so it lasts only until this tab closes or reloads. Download it now to keep it.',
};
const PRIVATE = 'It may include your secret player key. Keep the file private and never attach it to a public bug report.';

/** What the kept-aside note says, in the banner and in Settings > Save & backup (see collectionRecoveryNote). */
export const COLLECTION_RECOVERY_NOTES: Record<KeptState, string> = {
  stored: `Unreadable collection data ${KEPT.stored} ${PRIVATE}`,
  unsaved: `Unreadable collection data ${KEPT.unsaved} ${PRIVATE}`,
};

/** Added to the note while stats are kept aside: the ones in use were rebuilt (game/statsRecovery.ts), not started over. */
export const STATS_REBUILT_NOTE = 'Your stats were rebuilt from your pack history and collection.';

/** Added while a damaged player record is kept aside and the one stored now has its key: only the broken fields were repaired (game/player.ts). */
export const PLAYER_REPAIRED_NOTE = 'Your player key was kept, and its ticket count was repaired.';

/** Added while the stored player record is a kept-aside one with no key that can be read: packs stay sealed (game/player.ts). */
export const PLAYER_PAUSED_NOTE = "Packs are paused until you restore a backup or start a new player in Settings > Save & backup.";

/** Which kinds of data are kept aside, stored or for this visit (none of the stored ones when storage can't be read). */
const keptEntries = (): Entry[] => {
  const stored = getStoredArchive();
  return [...(stored.status === 'found' ? entriesOf(readArchive(stored.raw)) : []), ...unsaved];
};

/** The secret key a raw player record names, when it names one that can be read. */
const keyOf = (raw: string | null): string | undefined => {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    return isRecord(value) && typeof value.secretKey === 'string' && /^[0-9a-f]{64}$/.test(value.secretKey) ? value.secretKey : undefined;
  } catch {
    return undefined;
  }
};

/** What the note adds about kept-aside player records: their key kept in a repaired record, or packs paused. */
const playerNote = (kept: Entry[]): string | undefined => {
  if (kept.length === 0) return undefined;
  let now: string | null;
  try {
    now = localStorage.getItem(PLAYER_KEY);
  } catch {
    return undefined;
  }
  const key = keyOf(now);
  if (key === undefined) return kept.some((entry) => entry.raw === now) ? PLAYER_PAUSED_NOTE : undefined;
  return kept.some((entry) => entry.raw !== now && keyOf(entry.raw) === key) ? PLAYER_REPAIRED_NOTE : undefined;
};

const noteFor = (state: KeptState): string => {
  const entries = keptEntries();
  const players = entries.filter((entry) => entry.key === PLAYER_KEY);
  const kinds = [
    entries.some((entry) => entry.key === undefined) && 'collection',
    players.length > 0 && 'player',
    entries.some((entry) => entry.key === STATS_KEY) && 'stats',
  ].filter((kind): kind is string => !!kind);
  if (kinds.length === 0 || (kinds.length === 1 && kinds[0] === 'collection')) return COLLECTION_RECOVERY_NOTES[state];
  const what = `Unreadable ${kinds.length === 1 ? kinds[0] : `${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}`} data`;
  const added = [playerNote(players), kinds.includes('stats') && STATS_REBUILT_NOTE].filter((note): note is string => !!note);
  return `${what} ${KEPT[state]}${added.map((note) => ` ${note}`).join('')} ${PRIVATE}`;
};

/** Older payloads let go to stay within the limits: the stored archive's count plus this visit's. */
const droppedCount = (): number => {
  const stored = getStoredArchive();
  if (stored.status !== 'found') return droppedThisVisit;
  return (readArchive(stored.raw).dropped ?? 0) + droppedThisVisit;
};

/**
 * The kept-aside note as it is now, saying how many older payloads were let go; undefined when nothing
 * is kept, or when the archive can't be read (an archive that may not exist is no reason to warn, nor
 * to drop a note already shown: callers keep the current note on 'unavailable').
 */
export const collectionRecoveryNote = (): string | undefined => {
  const state = collectionRecoveryState();
  if (state === 'none' || state === 'unavailable') return undefined;
  const dropped = droppedCount();
  if (dropped === 0) return noteFor(state);
  return `${noteFor(state)} ${dropped} older unreadable ${dropped === 1 ? 'save was' : 'saves were'} let go to make room.`;
};

/**
 * True when this browser is known to hold kept-aside collection data (the stored archive is in the
 * private export). False when there is none, or when the archive can't be read right now.
 */
export const hasCollectionRecovery = (): boolean => {
  const state = collectionRecoveryState();
  return state === 'stored' || state === 'unsaved';
};

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
 * The stored archive (wrapped if it can't be read) with this visit's unsaved payloads after it (those
 * `ours` accepts), and whether those added any.
 */
const keptArchive = (ours: (entry: Entry) => boolean = () => true): { file: Archive; added: boolean } | null => {
  const stored = getStoredArchive();
  if (stored.status === 'unavailable') {
    throw (stored.error instanceof Error ? stored.error : new DOMException('Storage read denied', 'SecurityError'));
  }
  const raw = stored.status === 'found' ? stored.raw : null;
  const archive = raw === null ? null : readArchive(raw);
  const kept = entriesOf(archive);
  const extra = unsaved.filter((entry) => ours(entry) && !kept.some((k) => sameEntry(k, entry)));
  // Payloads let go this visit count only beside one of the payloads they were kept with.
  const droppedNow = extra.length > 0 || unsaved.every(ours) ? droppedThisVisit : 0;
  const dropped = (archive?.dropped ?? 0) + droppedNow;
  if (archive && extra.length === 0 && droppedNow === 0) return { file: archive, added: false };
  if (archive) return { file: withLater(archive, [...(archive.later ?? []), ...extra], dropped), added: true };
  if (extra.length > 0) return { file: withLater(extra[0], extra.slice(1), dropped), added: true };
  return null;
};

/**
 * The kept-aside data a backup carries: the stored text as is, or with this visit's unsaved payloads when
 * storage had no room for them. Only payloads kept for the player stored now go in (by secret key, as the
 * record's other fields change with every pack), so a save another tab imported never carries this tab's.
 */
export const exportedCollectionRecovery = (stored: string | null): string | null => {
  const now = localStorage.getItem(PLAYER_KEY);
  const key = keyOf(now);
  const kept = keptArchive((entry) => (key === undefined ? entry.player === now : keyOf(entry.player) === key));
  return kept?.added ? JSON.stringify(kept.file) : stored;
};

/**
 * Everything kept aside, as a JSON file built in this browser: the stored archive (wrapped if it
 * can't be read) with this visit's unsaved payloads after it. Null when nothing is kept.
 */
export const collectionRecoveryFile = (now = new Date()): { name: string; text: string } | null => {
  const kept = keptArchive();
  if (!kept) return null;
  const file = kept.file;
  return { name: `brainrot-collection-recovery-${now.toISOString().split('T')[0]}.json`, text: JSON.stringify(file, null, 2) };
};

export type DownloadRecoveryResult = 'downloaded' | 'none' | 'unavailable';

/** Save the kept-aside data as a file; nothing leaves this browser. */
export const downloadCollectionRecovery = (): DownloadRecoveryResult => {
  let file: { name: string; text: string } | null;
  try {
    file = collectionRecoveryFile();
  } catch {
    return 'unavailable';
  }
  if (!file) return 'none';
  const url = URL.createObjectURL(new Blob([file.text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return 'downloaded';
};

/** 'changed': the kept-aside data isn't what the player was shown, so nothing was removed. 'refused': storage wouldn't remove it. */
export type DiscardResult = 'discarded' | 'changed' | 'refused';

/**
 * Delete the kept-aside data for good, stored and unsaved, if it is still what the player was shown
 * (`shown`, from collectionRecoveryPrint when they were asked); this visit's copies go only once storage
 * has let go of the stored ones.
 */
export const discardCollectionRecovery = (shown: string | null): DiscardResult => {
  let gone: Entry[];
  try {
    const print = currentPrint();
    if (print !== null && print !== shown) return 'changed';
    const stored = localStorage.getItem(ARCHIVE_KEY);
    const kept = [...entriesOf(stored === null ? null : readArchive(stored)), ...unsaved];
    // The stored collection or stats discarded now or before, if a write hasn't replaced them yet.
    gone = [STORAGE_KEYS.COLLECTION, STATS_KEY].flatMap((key) => {
      const raw = localStorage.getItem(key);
      const entry = raw === null ? null : withKey({ raw, player: null }, key);
      return entry && [...kept, ...discarded].some((k) => sameEntry(k, entry)) ? [entry] : [];
    });
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
  discarded = gone;
  return 'discarded';
};
