/**
 * The local player: an Ed25519 key (their identity in pull proofs), a display
 * name, and the next ticket number. Stored in localStorage; exported with saves.
 */
import { fingerprint, fromHex, generateKeypair, normalizeName, publicKeyFromSecret, toHex } from '../engine';

const STORAGE_KEY = 'brainrot-player-v1';

interface StoredPlayer {
  secretKey: string;
  name: string;
  nextNonce: number;
  createdAt: number;
}

export interface Player {
  name: string;
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
  fingerprint: string;
}

const ADJECTIVES = ['Sigma', 'Skibidi', 'Rizzy', 'Goated', 'Mewing', 'Unhinged', 'Feral', 'Bussin', 'Aura', 'Cooked', 'Delulu', 'Cracked', 'Based', 'Zesty', 'Chopped', 'Lowkey'];
const NOUNS = ['Toaster', 'Noodle', 'Gremlin', 'Goblin', 'Capybara', 'Pigeon', 'Banana', 'Raccoon', 'Shrimp', 'Croissant', 'Wizard', 'Penguin', 'Meatball', 'Frog', 'Biscuit', 'Cactus'];

const randomName = () => {
  const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];
  return `${pick(ADJECTIVES)} ${pick(NOUNS)} ${Math.floor(Math.random() * 90) + 10}`;
};

const read = (): StoredPlayer | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredPlayer;
    if (!/^[0-9a-f]{64}$/.test(parsed.secretKey) || !Number.isSafeInteger(parsed.nextNonce)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const write = (stored: StoredPlayer) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    return true;
  } catch (error) {
    console.error('Could not save player identity', error);
    return false;
  }
};

/**
 * localStorage is the source of truth, because other tabs write it too: every read and write goes
 * through it, so a stale tab can never move the ticket counter backwards or switch keys behind
 * another tab's back. `memory` only covers browsers where storage is unavailable.
 */
let memory: StoredPlayer | null = null;

const current = (): StoredPlayer => {
  const fresh = read();
  if (fresh) return (memory = fresh);
  if (memory) return memory;
  memory = { secretKey: toHex(generateKeypair().secretKey), name: randomName(), nextNonce: 0, createdAt: Date.now() };
  write(memory);
  return memory;
};

const update = (change: (s: StoredPlayer) => StoredPlayer): StoredPlayer => {
  memory = change(current());
  write(memory);
  return memory;
};

let lastKey: { secretKeyHex: string; publicKey: Uint8Array } | null = null;

const toPlayer = (s: StoredPlayer): Player => {
  const secretKey = fromHex(s.secretKey);
  if (lastKey?.secretKeyHex !== s.secretKey) lastKey = { secretKeyHex: s.secretKey, publicKey: publicKeyFromSecret(secretKey) };
  const { publicKey } = lastKey;
  return { name: s.name, secretKey, publicKey, publicKeyHex: toHex(publicKey), fingerprint: fingerprint(publicKey) };
};

export const getPlayer = (): Player => toPlayer(current());

/** The ticket number the next pack will use (without consuming it). */
export const peekNonce = (): number => current().nextNonce;

/** The player and how many tickets it has used, read from one record so neither belongs to another key. */
export const getPlayerTickets = (): { player: Player; nextNonce: number } => {
  const record = current();
  return { player: toPlayer(record), nextNonce: record.nextNonce };
};

/**
 * Consume the next ticket number. Every opened pack uses a new one. Returns the player it belongs
 * to as well, read from the same record, so a pack never pairs one key with another key's nonce.
 */
export const allocateNonce = (): { nonce: number; player: Player } => {
  let nonce = 0;
  const record = update((s) => {
    nonce = s.nextNonce;
    return { ...s, nextNonce: s.nextNonce + 1 };
  });
  return { nonce, player: toPlayer(record) };
};

/**
 * What a rename did, with the player as it is now stored: `saved`; `blank` or `unchanged` (nothing
 * written); or `failed` (this browser refused the write, so the old name stays).
 */
export interface RenameResult {
  status: 'saved' | 'blank' | 'unchanged' | 'failed';
  player: Player;
}

/** Change only the name, on the record read from storage now, so another tab's key and ticket counter stay intact. */
export const renamePlayer = (name: string): RenameResult => {
  const clean = normalizeName(name);
  const record = current();
  if (!clean) return { status: 'blank', player: toPlayer(record) };
  if (clean === record.name) return { status: 'unchanged', player: toPlayer(record) };
  const next = { ...record, name: clean };
  // Adopt the name only once it is stored, so the page never shows a name the next read would undo.
  if (!write(next)) return { status: 'failed', player: toPlayer(record) };
  memory = next;
  return { status: 'saved', player: toPlayer(next) };
};

/** For save export/import. The secret key is what makes pulls yours, so treat the export as private. */
export const exportPlayer = (): string => JSON.stringify(current());

/** Parse an imported identity without creating or changing this browser's player. */
export const parsePlayer = (raw: string): StoredPlayer | null => {
  try {
    const incoming: unknown = JSON.parse(raw);
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return null;
    const value = incoming as Record<string, unknown>;
    if (typeof value.secretKey !== 'string' || !/^[0-9a-f]{64}$/.test(value.secretKey)
      || typeof value.name !== 'string'
      || typeof value.nextNonce !== 'number' || !Number.isSafeInteger(value.nextNonce) || value.nextNonce < 0
      || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt < 0) return null;
    return { secretKey: value.secretKey, name: value.name, nextNonce: value.nextNonce, createdAt: value.createdAt };
  } catch {
    return null;
  }
};

/** Whether `secretKey` is this browser's player, without creating one. */
export const isCurrentPlayer = (secretKey: string): boolean => (read() ?? memory)?.secretKey === secretKey;

/**
 * Changed by every save-file import, before it writes anything else, so a tab that loaded the save
 * from before can tell even when the import brings back the same player.
 */
export const SAVE_STAMP_KEY = 'brainrot-save-stamp-v1';

/** A new value for SAVE_STAMP_KEY. */
export const newSaveStamp = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Which save this browser holds: the player, whether its record is stored, and the import stamp. */
export interface SaveMark {
  key: string;
  stored: boolean;
  stamp: string | null;
}

export const saveMark = (): SaveMark => {
  // First, so a browser without a player stores its new guest before `stored` is read.
  const key = getPlayer().publicKeyHex;
  let stamp: string | null = null;
  try {
    stamp = localStorage.getItem(SAVE_STAMP_KEY);
  } catch { /* Storage unavailable: no import can have happened either. */ }
  return { key, stored: read() !== null, stamp };
};

/**
 * Whether storage still holds the save `loaded` was taken from: the same player, no import since,
 * and its record not cleared (a tab that loaded without a stored record, as when storage is
 * unavailable, stays the same if one appears).
 */
export const sameSave = (loaded: SaveMark, now: SaveMark): boolean =>
  loaded.key === now.key && loaded.stamp === now.stamp && (now.stored || !loaded.stored);

/**
 * Calls `onChange` when another tab stores a player record (an import, a switch, a rename), imports a
 * save, or clears this browser's storage, so a tab can find out that its save changed before it next
 * writes. The storage event only reaches other tabs, and can arrive late: writers still compare
 * saveMark() themselves. Returns the unsubscribe.
 */
export const watchPlayer = (onChange: () => void): (() => void) => {
  const listener = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY || event.key === SAVE_STAMP_KEY) onChange();
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
};

export const importPlayer = (raw: string): boolean => {
  const incoming = parsePlayer(raw);
  if (!incoming) return false;
  try {
    // Import must not create a guest or replace the memory fallback until the key is durable.
    const existing = read() ?? memory;
    const next = {
      ...incoming,
      name: normalizeName(incoming.name) || randomName(),
      // Never move the ticket counter backwards for the same key (that would replay old packs).
      nextNonce: existing?.secretKey === incoming.secretKey ? Math.max(existing.nextNonce, incoming.nextNonce) : incoming.nextNonce,
    };
    if (!write(next)) return false;
    memory = next;
    return true;
  } catch {
    return false;
  }
};
