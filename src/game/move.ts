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
import { newSaveStamp, parsePlayer, SAVE_STAMP_KEY, ticketCount, withAllowedName } from './player';
import { isQuotaError, isValidSaveValue } from './saveFile';
import { withReadableCache } from './history';
import { isStaging } from './staging';

const OLD_ORIGIN: string = import.meta.env.VITE_OLD_ORIGIN || '';
const OLD_SITE_URL: string = import.meta.env.VITE_OLD_SITE_URL || '';
const PLAYER_KEY = 'brainrot-player-v1';
const BACKUP_KEY = 'brainrot-before-move-v1';
/**
 * A move that replaces progress keeps a copy of the save it replaced. BACKUP_KEY and PENDING_KEY hold the
 * two most recent distinct copies, never more: BACKUP_KEY the older one (or the only one), PENDING_KEY
 * the newer. Before taking a copy, a move moves PENDING_KEY's into BACKUP_KEY's place (the oldest goes),
 * then copies the save here into PENDING_KEY, or into BACKUP_KEY while there's no copy at all. So a copy
 * is only written over by a newer one taking its place. It takes no copy when the newest one already
 * holds the save here (see alreadyKept). Which key holds what, after:
 * - 'saved' or 'partial': the newest copy (PENDING_KEY's, or BACKUP_KEY's if it's the only one) holds the
 *   save this move replaced, and the older one the save before that; after 'partial' the newest is whole
 *   where the save here may be a mix of both saves.
 * - a failed write that was undone ('full', 'invalid'): the copy just taken goes, as the save it holds is
 *   back in place; a pending copy moved into BACKUP_KEY's place first stays there.
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

/** Never on staging (staging.ts): its saves are disposable, and the old address only hands saves to production. */
export const canBringOldSave = (): boolean => !!OLD_ORIGIN && !!OLD_SITE_URL && OLD_ORIGIN !== window.location.origin && !isStaging();

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
  // The raw counter, not ticketCount's floor: a ticket the history records makes the history non-empty below.
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

/**
 * Never progress: what marks a save, this device's preferences, caches it can rebuild, the re-open
 * bookkeeping (reopenJob.ts) a reload writes on its own: the done mark, a re-open waiting to resume, its backoff,
 * and the best cards (bestCards.ts), derived from the packs a save's tickets rebuild.
 */
const NO_PROGRESS_KEYS = new Set<string>([SAVE_STAMP_KEY, DATA_VERSION_KEY, STORAGE_KEYS.SETTINGS, STORAGE_KEYS.SELECTED_SET,
  STORAGE_KEYS.OPEN_CUE_PLAYS, STORAGE_KEYS.FIRST_CARD_CUE_PLAYS, STORAGE_KEYS.COLLECTION_RECOVERY_SEEN, 'brainrot-reopened-v1', 'brainrot-reopen-pending-v1', 'brainrot-reopen-backoff-v1',
  STORAGE_KEYS.BEST_CARDS]);

/** No number above 0, no text, no `true` and no list entry, at any depth: a fresh guest's stats, say. */
const holdsNothing = (value: unknown): boolean => value === null || value === 0 || value === false || value === ''
  || (Array.isArray(value) ? value.length === 0 : typeof value === 'object' && Object.values(value).every(holdsNothing));

/** A value here that nothing is lost by dropping: a guest who opened no packs, an empty collection. */
const holdsNoProgress = (key: string, raw: string | null): boolean => {
  if (raw === null || NO_PROGRESS_KEYS.has(key)) return true;
  // Floored by the history as the player's own reads are: a ticket recorded past a stale counter is progress.
  if (key === PLAYER_KEY) return ticketCount(raw) === 0;
  try {
    return holdsNothing(JSON.parse(raw));
  } catch {
    return false;
  }
};

/**
 * Whether the newest copy (PENDING_KEY's, or BACKUP_KEY's while none is pending) already holds everything
 * in `save`, the save here: then a move that ended 'partial' took it, whole where the save here may not
 * be. Each key here must match that copy, match what this move writes anyway, or hold no progress (the
 * guest a reload made when the player couldn't be put back). Only that one copy, so no two saves' keys
 * are taken for one and the copies stay in order. A matching stamp or player isn't enough: packs
 * opened since would be in neither copy.
 */
const alreadyKept = (save: Record<string, string | null>, incoming: Record<string, string>): boolean => {
  let copy: unknown;
  try {
    copy = JSON.parse(localStorage.getItem(PENDING_KEY) ?? localStorage.getItem(BACKUP_KEY) ?? 'null');
  } catch {
    return false;
  }
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) return false;
  const kept = copy as Record<string, unknown>;
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
 * as a backup (see PENDING_KEY), unless the newest copy already holds it (see alreadyKept).
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
  // A blocked display name isn't brought over (see isNameAllowed): this is never the player here (see 'same').
  if (PLAYER_KEY in incoming) incoming[PLAYER_KEY] = withAllowedName(incoming[PLAYER_KEY]);
  // No version key means the first format (runMigrations reads it so). Written explicitly, so this
  // browser's own version can't stand in for an older save's and skip its migrations.
  const version = incoming[DATA_VERSION_KEY] ?? '1';
  if (!/^[1-9][0-9]*$/.test(version) || Number(version) > CURRENT_DATA_VERSION) return 'invalid';
  // Unreadable cached codes the old address kept (#652) are dropped, as this address reads them, not refused.
  if (STORAGE_KEYS.HISTORY in incoming) incoming[STORAGE_KEYS.HISTORY] = withReadableCache(incoming[STORAGE_KEYS.HISTORY])!;
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
    // (if that fails, both stay); the oldest copy goes, and there are still at most two. The newest
    // copy, if it holds everything here, is whole where the save here may not be: then none is taken.
    if (!alreadyKept(backup, incoming)) {
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
    // A failed restore keeps every copy, the one just taken included; Save & backup then reloads ('partial').
    if (!restoreKeys(previous)) return 'partial';
    // All back as it was, so the copy just taken goes (removing never needs room).
    if (staged !== null) {
      try { localStorage.removeItem(staged); } catch { /* It matches what's back in place. */ }
    }
    return isQuotaError(e) ? 'full' : 'invalid';
  }
  // Moved. The copies stay as they are: the newest holds the save this move replaced (see PENDING_KEY).
  return 'saved';
};

type Message = { type?: string; save?: unknown };

export const RETRY_LOST_NOTE = 'Nothing came from the old address. Tap Bring my save there to try again, or close this window.';
export const OPENER_LOST_NOTE = 'This window lost touch with the old address. Close it, then tap Bring my save there again.';

/** Stops the receiver this page is running (its listeners), if any. */
let stopActiveReceiver: (() => void) | undefined;

/** Stop listening for a hand-over; a later receiveSave replaces any earlier one this way too. */
export const stopReceiver = (): void => {
  stopActiveReceiver?.();
  stopActiveReceiver = undefined;
};

/**
 * If the old address opened this window to hand over a save, take it in and report back; resolves
 * true when this window was that receiver (the app then doesn't start in it). A failure ('full',
 * 'invalid', 'partial') leaves the window open with its note. A retry from the old address opens the
 * same named window at #/receive, which only changes this document's fragment (main.tsx doesn't run
 * again), so that restarts the handshake here.
 */
export const receiveSave = (): Promise<boolean> => {
  stopReceiver();
  const initialOpener = window.opener as Window | null;
  if (!canBringOldSave() || window.location.hash !== '#/receive' || !initialOpener) return Promise.resolve(false);
  history.replaceState(null, '', import.meta.env.BASE_URL);
  const root = document.getElementById('root');
  const show = (text: string) => {
    if (root) root.textContent = text;
  };
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onMessage: ((event: MessageEvent<Message>) => void) | undefined;
    // Set once a save came: from then on this window is a receiver, and the game never starts in it.
    let received = false;

    const cleanup = () => {
      clearTimeout(timer);
      if (onMessage) window.removeEventListener('message', onMessage);
      timer = undefined;
      onMessage = undefined;
    };
    const stopAll = () => {
      cleanup();
      window.removeEventListener('hashchange', onHashChange);
      if (stopActiveReceiver === stopAll) stopActiveReceiver = undefined;
    };

    const startHandshake = (opener: Window) => {
      cleanup();
      show('Bringing your save over…');
      timer = setTimeout(() => {
        // Nothing came. On first load the game starts here as usual; after a result, wait for another retry.
        if (received) {
          cleanup();
          show(RETRY_LOST_NOTE);
          return;
        }
        stopAll();
        resolve(false);
      }, 15000);
      onMessage = (event: MessageEvent<Message>) => {
        if (event.origin !== OLD_ORIGIN || event.source !== opener || event.data?.type !== 'brainrot-save') return;
        cleanup();
        const result = importSave(event.data.save);
        opener.postMessage({ type: 'brainrot-move-result', result }, OLD_ORIGIN);
        show(result === 'saved' || result === 'same' ? 'Your save is here. You can close this window.'
          : result === 'partial' ? PARTIAL_MOVE_NOTE : result === 'full' ? FULL_MOVE_NOTE : 'Nothing was changed. You can close this window.');
        received = true;
        resolve(true);
        // A failure stays open so its note can be read, and listens for a retry (onHashChange).
        if (result === 'saved' || result === 'same' || result === 'kept') {
          stopAll();
          window.close();
        }
      };
      window.addEventListener('message', onMessage);
      opener.postMessage({ type: 'brainrot-ready' }, OLD_ORIGIN);
    };

    const onHashChange = () => {
      if (window.location.hash !== '#/receive') return;
      history.replaceState(null, '', import.meta.env.BASE_URL);
      const opener = window.opener as Window | null;
      // Only the window that opened this one may hand a save in: its messages are checked against it.
      if (!opener || opener !== initialOpener) {
        stopAll();
        show(OPENER_LOST_NOTE);
        return;
      }
      startHandshake(opener);
    };

    stopActiveReceiver = stopAll;
    window.addEventListener('hashchange', onHashChange);
    startHandshake(initialOpener);
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
