/**
 * Cards of your own packs that this device re-opened (tickets the pack history has no cards for), so
 * a profile never re-opens the same ticket twice. Kept in IndexedDB, not localStorage: a big history
 * already fills localStorage, and this can hold every pack you've opened.
 *
 * Read synchronously from memory (profiles are built synchronously), so `loadPackStore` must finish
 * before the app reads it; writes go to memory at once and to IndexedDB in the background.
 */
const DB_NAME = 'brainrot-packs';
const STORE = 'reopened';

/** `${setId}@${setVersion}|${first 16 hex of the key}|${nonce}`: the history's key prefix plus the set. */
const keyOf = (setKey: string, publicKeyHex: string, nonce: number) => `${setKey}|${publicKeyHex.slice(0, 16)}|${nonce}`;

const memory = new Map<string, string>();
let db: Promise<IDBDatabase | null> | null = null;

const open = (): Promise<IDBDatabase | null> =>
  (db ??= new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      // Private windows and old browsers: memory only, so re-opened packs last until the page closes.
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));

/** Read every stored pack into memory. Never rejects: without IndexedDB the store is memory only. */
export const loadPackStore = async (): Promise<void> => {
  const database = await open();
  if (!database) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = database.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const keys = store.getAllKeys();
      const values = store.getAll();
      tx.oncomplete = () => {
        keys.result.forEach((k, i) => memory.set(String(k), values.result[i] as string));
        resolve();
      };
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
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
  db = null;
};
