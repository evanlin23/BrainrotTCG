/**
 * Moving the site to a new address (docs/HOSTING.md). A save lives in the browser's storage for the
 * address it was made on, so after a move it has to be handed over, and it holds the player's secret
 * key. It goes window to window with postMessage, never in a URL (URLs end up in browser history and
 * history sync). Both sides check the other's origin, which the browser enforces, so no other page
 * can hand a save in or take one out:
 *
 * - The old address (scripts/redirect-site.ts) offers "Bring my save". That opens this site at
 *   `#/receive`; it says it's ready, gets the save and reports back (`receiveSave`).
 * - From here, Settings can fetch it instead: it opens the old address at `#/send`, which sends the
 *   save back (`fetchOldSave`), for players who arrive through a new link. Settings asks in the page
 *   before replacing a different save, not with a browser dialog: one can open behind the old
 *   address's window, and then it looks as if nothing happened.
 *
 * Only builds with VITE_OLD_ORIGIN (set by the deploy once the site has moved) do any of this.
 */
const OLD_ORIGIN: string = import.meta.env.VITE_OLD_ORIGIN || '';
const OLD_SITE_URL: string = import.meta.env.VITE_OLD_SITE_URL || '';
const PLAYER_KEY = 'brainrot-player-v1';
const BACKUP_KEY = 'brainrot-before-move-v1';
/** What makes a save worth keeping: replacing any of these asks first. */
const PROGRESS_KEYS = [PLAYER_KEY, 'brainrot-found-collection-v1', 'brainrot-history-v1', 'brainrot-stats-v1', 'brainrot-achievements-v1'];

/** 'same': this player's save is already here, so nothing was written. */
export type MoveResult = 'saved' | 'same' | 'kept' | 'invalid';

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

const brainrotKeys = () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((k): k is string => !!k?.startsWith('brainrot-'));

const askToReplace = () =>
  window.confirm('Bring over your save from the old Brainrot TCG address? It replaces the save in this browser now (that one is kept as a backup).');

/** Undo a partial handover: free every touched key first, then put the previous values back. */
const restoreKeys = (previous: Map<string, string | null>) => {
  for (const k of previous.keys()) {
    try { localStorage.removeItem(k); } catch { /* Still put back the rest. */ }
  }
  for (const [k, v] of previous) {
    if (v === null) continue;
    try { localStorage.setItem(k, v); } catch { /* A replaced save is still under BACKUP_KEY. */ }
  }
};

/**
 * Write a handed-over save into this address's storage. If there's already progress here that isn't
 * the same player, `replace` decides (by asking, unless told otherwise) and the replaced save is kept
 * under BACKUP_KEY.
 */
export const importSave = (save: unknown, replace: () => boolean = askToReplace): MoveResult => {
  if (!save || typeof save !== 'object') return 'invalid';
  const incoming = Object.fromEntries(Object.entries(save).filter(([k, v]) => k.startsWith('brainrot-') && k !== BACKUP_KEY && typeof v === 'string')) as Record<string, string>;
  if (!PROGRESS_KEYS.some((k) => k in incoming)) return 'invalid';
  const here = secretOf(localStorage.getItem(PLAYER_KEY));
  if (here && here === secretOf(incoming[PLAYER_KEY])) return 'same';
  const progress = hasProgress();
  if (progress && !replace()) return 'kept';
  // What the incoming writes replace (null: absent), put back if the incoming save doesn't fit.
  const previous = new Map(Object.keys(incoming).map((k): [string, string | null] => [k, localStorage.getItem(k)]));
  let replaced: string[] = [];
  if (progress) {
    const backup = Object.fromEntries(brainrotKeys().filter((k) => k !== BACKUP_KEY).map((k) => [k, localStorage.getItem(k)]));
    // A full or unavailable storage area must not cost the player the save being replaced.
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
    } catch {
      return 'invalid';
    }
    replaced = Object.keys(backup);
    for (const k of replaced) previous.set(k, backup[k]);
  }
  try {
    for (const k of replaced) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(incoming)) localStorage.setItem(k, v);
  } catch {
    restoreKeys(previous);
    return 'invalid';
  }
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
      if (root) root.textContent = result === 'saved' || result === 'same' ? 'Your save is here. You can close this window.' : 'Nothing was changed. You can close this window.';
      finish(true);
      window.close();
    };
    window.addEventListener('message', onMessage);
    opener.postMessage({ type: 'brainrot-ready' }, OLD_ORIGIN);
  });
};

/**
 * From here: open the old address, which sends its save back (Settings). The small window is closed
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

/** Keep this browser's save under `backupKey` before something replaces it (a move, an imported file). */
export const backUpSave = (backupKey: string): boolean => {
  try {
    const keys = brainrotKeys().filter((key) => !key.startsWith('brainrot-before-'));
    if (keys.length === 0) return true;
    const backup = Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)]));
    localStorage.setItem(backupKey, JSON.stringify(backup));
    return true;
  } catch {
    return false;
  }
};
