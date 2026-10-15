/**
 * Cards of your own packs that this device re-opened (tickets the pack history has no cards for), so
 * a profile never re-opens the same ticket twice. Kept in IndexedDB, not localStorage: a big history
 * already fills localStorage, and this can hold every pack you've opened.
 *
 * Read synchronously from memory (profiles are built synchronously). Nothing is read up front: the
 * player's packs that need it are brought into memory a bounded page at a time (`hydratePackStore`,
 * driven by game/profiles.ts), so startup never loads every stored pack. Writes go to memory at once
 * and to IndexedDB in the background.
 */
const DB_NAME = 'brainrot-packs';
const STORE = 'reopened';

/** `${setId}@${setVersion}|${first 16 hex of the key}|${nonce}`: the history's key prefix plus the set. */
const keyOf = (setKey: string, publicKeyHex: string, nonce: number) => `${setKey}|${publicKeyHex.slice(0, 16)}|${nonce}`;

const memory = new Map<string, string>();
let db: Promise<IDBDatabase | null> | null = null;

const open = (): Promise<IDBDatabase | null> => {
  if (db) return db;
  let settled = false;
  const pending = new Promise<IDBDatabase | null>((resolve) => {
    const fallback = () => {
      settled = true;
      resolve(null);
    };
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {
        const database = request.result;
        // A blocked request can still succeed later; resetting also abandons this attempt.
        if (settled || db !== pending) {
          database.close();
          resolve(null);
          return;
        }
        database.onversionchange = () => {
          database.close();
          // An old connection's late event must not discard a newer cached attempt.
          if (db === pending) db = null;
        };
        settled = true;
        resolve(database);
      };
      // Private windows and old browsers: memory only, so re-opened packs last until the page closes.
      request.onerror = fallback;
      request.onblocked = fallback;
    } catch {
      fallback();
    }
  });
  return db = pending;
};

/** A stored pack's cards in the app's card code ("id,id*G,..."), if this device re-opened it. */
export const getStoredPack = (setKey: string, publicKeyHex: string, nonce: number): string | undefined =>
  memory.get(keyOf(setKey, publicKeyHex, nonce));

export interface StoredPack {
  setKey: string;
  publicKeyHex: string;
  nonce: number;
  cards: string;
}

/** Keep re-opened packs. Resolves once they're on disk (or right away without IndexedDB). */
export const putStoredPacks = async (packs: readonly StoredPack[]): Promise<void> => {
  if (packs.length === 0) return;
  for (const p of packs) memory.set(keyOf(p.setKey, p.publicKeyHex, p.nonce), p.cards);
  const database = await open();
  if (!database) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = database.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const p of packs) store.put(p.cards, keyOf(p.setKey, p.publicKeyHex, p.nonce));
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
};

/** For tests. */
export const resetPackStore = () => {
  memory.clear();
  // Also release an already-open connection; an abandoned pending attempt closes on success.
  void db?.then(database => database?.close());
  db = null;
};

/** A page is small enough to release before requesting the next one. No unrelated keys are read. */
export const PACK_READ_PAGE = 64;
export type StoredPackRef = Omit<StoredPack, 'cards'>;
let activeReads = 0;

/**
 * Demand-read a page without retaining it in the synchronous cache. An absent entry is
 * undefined; unavailable/failed storage rejects, so a caller must not mistake it for a cache miss
 * and start re-mining.
 */
export const readStoredPacks = async (packs: readonly StoredPackRef[], signal?: AbortSignal): Promise<(string | undefined)[]> => {
  signal?.throwIfAborted();
  if (packs.length > PACK_READ_PAGE) throw new RangeError(`Read at most ${PACK_READ_PAGE} packs per page`);
  if (packs.length === 0) return [];
  const keys = packs.map(pack => keyOf(pack.setKey, pack.publicKeyHex, pack.nonce));
  if (activeReads >= 2) throw new Error('Pack cache is busy; retry after the current page');
  activeReads++;
  let stopWaiting: (() => void) | undefined;
  try {
    const pending = open();
    const database = await (signal ? Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        stopWaiting = () => signal.removeEventListener('abort', abort);
      }),
    ]) : pending);
    stopWaiting?.();
    signal?.throwIfAborted();
    if (!database) {
      // A new explicit read is a retry, including a blocked attempt whose late success must close.
      if (db === pending) db = null;
      throw new Error('Saved pack cache is unavailable; retry before restoring profile totals');
    }
    return await new Promise<(string | undefined)[]>((resolve, reject) => {
      let cleanup = () => {};
      try {
        const tx = database.transaction(STORE, 'readonly');
        const abort = () => {
          try { tx.abort(); } catch { /* A transaction that already completed needs no cancellation. */ }
        };
        signal?.addEventListener('abort', abort, { once: true });
        cleanup = () => signal?.removeEventListener('abort', abort);
        tx.onerror = tx.onabort = () => {
          cleanup();
          reject(signal?.aborted ? signal.reason : new Error('Saved pack cache read failed; retry before restoring profile totals'));
        };
        const requests = keys.map(key => tx.objectStore(STORE).get(key) as IDBRequest<unknown>);
        tx.oncomplete = () => {
          cleanup();
          if (signal?.aborted) return reject(signal.reason);
          const values = requests.map(request => request.result);
          if (values.some(value => value !== undefined && typeof value !== 'string')) {
            reject(new Error('Saved pack cache contains an unreadable entry'));
          } else resolve(values as (string | undefined)[]);
        };
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  } finally {
    stopWaiting?.();
    activeReads--;
  }
};

/**
 * Bring these packs' stored cards into memory for the synchronous reads, one bounded page at a time
 * and one page in flight. Only the asked-for keys are read; packs already in memory are skipped and
 * never overwritten. Resolves true once every page is in. Resolves false as soon as `keep` turns
 * false (the page read meanwhile is dropped, so a retired player's read can't land). Rejects on abort
 * or a failed read; pages already read stay. Without IndexedDB at all nothing can have been saved.
 */
export const hydratePackStore = async (
  packs: readonly StoredPackRef[],
  signal?: AbortSignal,
  keep: () => boolean = () => true,
): Promise<boolean> => {
  signal?.throwIfAborted();
  const keys = packs.map(pack => keyOf(pack.setKey, pack.publicKeyHex, pack.nonce));
  const wanted = packs.filter((_pack, i) => !memory.has(keys[i]));
  if (wanted.length === 0 || typeof indexedDB === 'undefined') return true;
  for (let start = 0; start < wanted.length; start += PACK_READ_PAGE) {
    if (!keep()) return false;
    const page = wanted.slice(start, start + PACK_READ_PAGE);
    const values = await readStoredPacks(page, signal);
    if (!keep()) return false;
    page.forEach((pack, i) => {
      const key = keyOf(pack.setKey, pack.publicKeyHex, pack.nonce);
      const value = values[i];
      if (value !== undefined && !memory.has(key)) memory.set(key, value);
    });
  }
  return true;
};
