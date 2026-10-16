/**
 * Moving the site to a new address (docs/HOSTING.md). A save lives in the browser's storage for the
 * address it was made on, so after a move it has to be handed over, and it holds the player's secret
 * key. It goes window to window with postMessage, never in a URL (URLs end up in browser history and
 * history sync). Both sides check the other's origin, which the browser enforces, so no other page
 * can hand a save in or take one out:
 *
 * - The old address (scripts/redirect-site.ts) offers "Bring my save". That opens this site at
 *   `#/receive`; it says it's ready, gets the save and reports back (`receiveSave`).
 * - From here, Save & backup can fetch it instead: it opens the old address at `#/send`, which sends the
 *   save back (`fetchOldSave`), for players who arrive through a new link. Save & backup asks in the page
 *   before replacing a different save, not with a browser dialog: one can open behind the old
 *   address's window, and then it looks as if nothing happened.
 *
 * Only builds with VITE_OLD_ORIGIN (set by the deploy once the site has moved) do any of this.
 */
import { STORAGE_KEYS } from '../constants';
import { CURRENT_DATA_VERSION, DATA_VERSION_KEY } from '../utils/migrations';
import { newSaveStamp, parsePlayer, SAVE_STAMP_KEY } from './player';
import { isValidSaveValue } from './saveFile';

const OLD_ORIGIN: string = import.meta.env.VITE_OLD_ORIGIN || '';
const OLD_SITE_URL: string = import.meta.env.VITE_OLD_SITE_URL || '';
const PLAYER_KEY = 'brainrot-player-v1';
const BACKUP_KEY = 'brainrot-before-move-v1';
/**
 * While an earlier move's copy is under BACKUP_KEY, a new move's copy waits here and takes BACKUP_KEY's
 * place in one write once the move succeeds. One still here (a move that couldn't be undone, or whose
 * copy couldn't take BACKUP_KEY's place) holds the save from before that move, so the next move moves
 * it into BACKUP_KEY before taking its own copy, unless it already holds the save here (see pendingHolds).
 * So there are never more than these two copies.
 */
const PENDING_KEY = 'brainrot-before-move-pending-v1';
/** These and the file import's backup (saveFile.ts): never handed over. */
const isBackupKey = (k: string) => k.startsWith('brainrot-before-');
/** What makes a save worth keeping: replacing any of these asks first. */
const PROGRESS_KEYS = [PLAYER_KEY, 'brainrot-found-collection-v1', 'brainrot-history-v1', 'brainrot-stats-v1', 'brainrot-achievements-v1'];

/**
 * 'same': this player's save is already here, so nothing was written. 'invalid': the save here is unchanged.
 * 'full': storage had no room for a copy or the incoming save, so the save here is unchanged.
 * 'partial': a write failed and putting the previous values back failed too.
 */
export type MoveResult = 'saved' | 'same' | 'kept' | 'invalid' | 'full' | 'partial';

export const PARTIAL_MOVE_NOTE = "Bringing the save over failed partway and couldn't be fully undone, so this browser may now"
  + ' hold parts of both saves. A save with progress that was here is kept as a backup in this browser.';

export const FULL_MOVE_NOTE = "This browser's storage is full, so nothing changed. Free up some space, then try again.";

const isQuotaError = (e: unknown) => e instanceof DOMException && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');

export const canBringOldSave = (): boolean => !!OLD_ORIGIN && !!OLD_SITE_URL && OLD_ORIGIN !== window.location.origin;

const secretOf = (player: string | null | undefined): string | undefined => {
  try {
    return (JSON.parse(player ?? '') as { secretKey?: string }).secretKey;
  } catch {
    return undefined;
  }
};

const parse = (key: string): unknown => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
};

/**
 * Real progress in this browser: a pack opened, cards, achievements. Just visiting (say, to look at
 * a friend's pull) makes a player key with no packs, and that's not a save worth asking about.
 */
export const hasProgress = (): boolean => {
  if (((parse(PLAYER_KEY) as { nextNonce?: number } | null)?.nextNonce ?? 0) > 0) return true;
  if (((parse('brainrot-stats-v1') as { packsOpened?: number } | null)?.packsOpened ?? 0) > 0) return true;
  return ['brainrot-found-collection-v1', 'brainrot-history-v1', 'brainrot-achievements-v1'].some((k) => {
    const value = parse(k);
    return Array.isArray(value) ? value.length > 0 : !!value && typeof value === 'object' && Object.keys(value).length > 0;
  });
};

/** A pending copy takes BACKUP_KEY's place in one write, then goes. Throws if storage refuses. */
const promotePending = () => {
  const pending = localStorage.getItem(PENDING_KEY);
  if (pending === null) return;
  localStorage.setItem(BACKUP_KEY, pending);
  localStorage.removeItem(PENDING_KEY);
};

/** Never progress: what marks a save, this device's preferences, and caches it can rebuild. */
const NO_PROGRESS_KEYS = new Set<string>([SAVE_STAMP_KEY, DATA_VERSION_KEY, STORAGE_KEYS.SETTINGS, STORAGE_KEYS.SELECTED_SET,
  STORAGE_KEYS.COLLECTION_RECOVERY_SEEN, 'brainrot-reopened-v1']);

/** No number above 0, no text, no `true` and no list entry, at any depth: a fresh guest's stats, say. */
const holdsNothing = (value: unknown): boolean => value === null || value === 0 || value === false || value === ''
  || (Array.isArray(value) ? value.length === 0 : typeof value === 'object' && Object.values(value).every(holdsNothing));

/** A value here that nothing is lost by dropping: a guest who opened no packs, an empty collection. */
const holdsNoProgress = (key: string, raw: string | null): boolean => {
  if (raw === null || NO_PROGRESS_KEYS.has(key)) return true;
  if (key === PLAYER_KEY) return parsePlayer(raw)?.nextNonce === 0;
  try {
    return holdsNothing(JSON.parse(raw));
  } catch {
    return false;
  }
};

/**
 * Whether the pending copy already holds everything in `save`, the save here: then a move that ended
 * 'partial' left it, whole where the save here may not be. Each key here must match the copy, match
 * what this move writes anyway, or hold no progress (the guest a reload made when the player couldn't
 * be put back). A matching stamp or player isn't enough: packs opened since would be in neither copy.
 */
const pendingHolds = (save: Record<string, string | null>, incoming: Record<string, string>): boolean => {
  const copy = parse(PENDING_KEY);
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) return false;
  const kept = copy as Record<string, unknown>;
  if (!Object.values(kept).every((v) => v === null || typeof v === 'string')) return false;
  return Object.entries(save).every(([k, v]) => v === kept[k] || v === incoming[k] || holdsNoProgress(k, v));
};

const brainrotKeys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k): k is string => !!k?.startsWith('brainrot-'));

const askToReplace = () =>
  window.confirm('Bring over your save from the old Brainrot TCG address? It replaces the save in this browser now (that one is kept as a backup).');

/** Undo a partial handover: free every touched key first, then put the previous values back. True if all match again. */
const restoreKeys = (previous: Map<string, string | null>): boolean => {
  for (const k of previous.keys()) {
    try { localStorage.removeItem(k); } catch { /* Still put back the rest. */ }
  }
  for (const [k, v] of previous) {
    if (v === null) continue;
    try { localStorage.setItem(k, v); } catch { /* A replaced save is still in the copy just taken. */ }
  }
  return [...previous].every(([k, v]) => {
    try { return localStorage.getItem(k) === v; } catch { return false; }
  });
};

/**
 * Write a handed-over save into this address's storage. If there's already progress here that isn't
 * the same player, `replace` decides (by asking, unless told otherwise) and the replaced save is kept
 * as a backup (see PENDING_KEY). The oldest copy is only replaced once a newer one has been stored.
 * A pending copy that already holds the save here (see pendingHolds) is kept as this move's copy instead.
 */
export const importSave = (save: unknown, replace: () => boolean = askToReplace): MoveResult => {
  if (!save || typeof save !== 'object') return 'invalid';
  // Not the old address's stamp: this browser gets a fresh one below.
  const incoming = Object.fromEntries(Object.entries(save).filter(([k, v]) => k.startsWith('brainrot-') && !isBackupKey(k) && k !== SAVE_STAMP_KEY && typeof v === 'string')) as Record<string, string>;
  if (!PROGRESS_KEYS.some((k) => k in incoming)) return 'invalid';
  const here = secretOf(localStorage.getItem(PLAYER_KEY));
  if (here && here === secretOf(incoming[PLAYER_KEY])) return 'same';
  // The same checks as an imported file (saveFile.ts), before asking or writing anything.
  if (PLAYER_KEY in incoming && !parsePlayer(incoming[PLAYER_KEY])) return 'invalid';
  // No version key means the first format (runMigrations reads it so). Written explicitly, so this
  // browser's own version can't stand in for an older save's and skip its migrations.
  const version = incoming[DATA_VERSION_KEY] ?? '1';
  if (!/^[1-9][0-9]*$/.test(version) || Number(version) > CURRENT_DATA_VERSION) return 'invalid';
  if (!Object.entries(incoming).every(([k, v]) => isValidSaveValue(k, v, Number(version)))) return 'invalid';
  incoming[DATA_VERSION_KEY] = version;
  const progress = hasProgress();
  if (progress && !replace()) return 'kept';
  // A fresh stamp, the first incoming write, so another tab still on the save here stops writing it (see saveMark).
  const writes: Record<string, string> = { [SAVE_STAMP_KEY]: newSaveStamp(), ...incoming };
  // What the incoming writes replace (null: absent), put back if the incoming save doesn't fit.
  const previous = new Map(Object.keys(writes).map((k): [string, string | null] => [k, localStorage.getItem(k)]));
  // The copy this move takes (BACKUP_KEY or PENDING_KEY), the only one a failed move removes.
  let staged: string | null = null;
  let replaced: string[] = [];
  if (progress) {
    const backup = Object.fromEntries(brainrotKeys().filter((k) => !isBackupKey(k)).map((k) => [k, localStorage.getItem(k)]));
    // A full or unavailable storage area must not cost the player the save being replaced, so if
    // either write fails nothing here is moved. A copy already pending makes room for this one first
    // (if that fails, both stay); the oldest copy goes, and there are still at most two. A pending
    // copy that holds everything here is whole where the save here may not be, so it stays this move's copy.
    if (!pendingHolds(backup, incoming)) {
      try {
        promotePending();
        const slot = localStorage.getItem(BACKUP_KEY) === null ? BACKUP_KEY : PENDING_KEY;
        localStorage.setItem(slot, JSON.stringify(backup));
        staged = slot;
      } catch (e) {
        return isQuotaError(e) ? 'full' : 'invalid';
      }
    }
    // Identity first, so a tab still on the save here stops writing before its other keys go (see saveMark).
    const identity = [PLAYER_KEY, SAVE_STAMP_KEY].filter((k) => k in backup);
    replaced = [...identity, ...Object.keys(backup).filter((k) => !identity.includes(k))];
    for (const k of replaced) previous.set(k, backup[k]);
  }
  try {
    for (const k of replaced) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(writes)) localStorage.setItem(k, v);
  } catch (e) {
    // A failed restore keeps every copy, the one just taken included; Save & restore then reloads ('partial').
    if (!restoreKeys(previous)) return 'partial';
    // All back as it was, so the copy just taken goes (removing never needs room).
    if (staged !== null) {
      try { localStorage.removeItem(staged); } catch { /* It matches what's back in place. */ }
    }
    return isQuotaError(e) ? 'full' : 'invalid';
  }
  // Moved (with or without progress here): a pending copy, this move's or one an earlier move left,
  // takes BACKUP_KEY's place. If that write fails, both stay until the next move.
  try { promotePending(); } catch { /* Both copies stay. */ }
  return 'saved';
};

type Message = { type?: string; save?: unknown };

/**
 * If the old address opened this window to hand over a save, take it in and report back; resolves
 * true when this window was that receiver (the app then doesn't start in it).
 */
export const receiveSave = (): Promise<boolean> => {
  const opener = window.opener as Window | null;
  if (!canBringOldSave() || window.location.hash !== '#/receive' || !opener) return Promise.resolve(false);
  history.replaceState(null, '', import.meta.env.BASE_URL);
  const root = document.getElementById('root');
  if (root) root.textContent = 'Bringing your save over…';
  return new Promise((resolve) => {
    const finish = (receiver: boolean) => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      resolve(receiver);
    };
    // Nothing came: start the game here as usual.
    const timer = setTimeout(() => finish(false), 15000);
    const onMessage = (event: MessageEvent<Message>) => {
      if (event.origin !== OLD_ORIGIN || event.source !== opener || event.data?.type !== 'brainrot-save') return;
      const result = importSave(event.data.save);
      opener.postMessage({ type: 'brainrot-move-result', result }, OLD_ORIGIN);
      if (root) {
        root.textContent = result === 'saved' || result === 'same' ? 'Your save is here. You can close this window.'
          : result === 'partial' ? PARTIAL_MOVE_NOTE : result === 'full' ? FULL_MOVE_NOTE : 'Nothing was changed. You can close this window.';
      }
      finish(true);
      // A failure stays open so its note can be read (the old address goes on to this one either way).
      if (result === 'saved' || result === 'same' || result === 'kept') window.close();
    };
    window.addEventListener('message', onMessage);
    opener.postMessage({ type: 'brainrot-ready' }, OLD_ORIGIN);
  });
};

/**
 * From here: open the old address, which sends its save back (Save & backup). The small window is closed
 * as soon as it answers, and the save is handed to the caller to import. 'timeout' when it never
 * answered (it didn't load, or was closed first).
 */
export const fetchOldSave = (): Promise<{ save: unknown } | 'none' | 'blocked' | 'timeout'> => {
  const popup = window.open(`${OLD_SITE_URL}#/send`, 'brainrot-send', 'popup,width=440,height=360');
  if (!popup) return Promise.resolve('blocked');
  return new Promise((resolve) => {
    const finish = (result: { save: unknown } | 'none' | 'timeout') => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      try {
        popup.close();
      } catch {
        // already closed
      }
      window.focus();
      resolve(result);
    };
    const timer = setTimeout(() => finish('timeout'), 20000);
    const onMessage = (event: MessageEvent<Message>) => {
      if (event.origin !== OLD_ORIGIN || event.source !== popup) return;
      if (event.data?.type === 'brainrot-save') finish({ save: event.data.save });
      else if (event.data?.type === 'brainrot-no-save') finish('none');
    };
    window.addEventListener('message', onMessage);
  });
};
