/**
 * The local player: an Ed25519 key (their identity in pull proofs), a display
 * name, and the next ticket number. Stored in localStorage; exported with saves.
 */
import { fingerprint, fromHex, generateKeypair, isNameAllowed, normalizeName, publicKeyFromSecret, toHex } from '../engine';
import { ticketsRecorded } from './history';

const STORAGE_KEY = 'brainrot-player-v1';
/** Where the player is kept: a storage event for it means another tab switched, imported or renamed the player. */
export const PLAYER_STORAGE_KEY = STORAGE_KEY;

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

export const ADJECTIVES = ['Sigma', 'Skibidi', 'Rizzy', 'Goated', 'Mewing', 'Unhinged', 'Feral', 'Bussin', 'Aura', 'Cooked', 'Delulu', 'Cracked', 'Based', 'Zesty', 'Chopped', 'Lowkey'];
export const NOUNS = ['Toaster', 'Noodle', 'Gremlin', 'Goblin', 'Capybara', 'Pigeon', 'Banana', 'Raccoon', 'Shrimp', 'Croissant', 'Wizard', 'Penguin', 'Meatball', 'Frog', 'Biscuit', 'Cactus'];

const randomName = () => {
  const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];
  return `${pick(ADJECTIVES)} ${pick(NOUNS)} ${Math.floor(Math.random() * 90) + 10}`;
};

/**
 * The name an imported identity is stored with: its own, unless that is blank or not allowed (see
 * isNameAllowed). A blocked name falls back to `kept` (this browser's name for the same key) when that
 * is allowed, so one player's name never lands on another key; otherwise a random name.
 */
const importedName = (name: string, kept?: string): string => {
  const clean = normalizeName(name);
  if (!clean) return randomName();
  if (isNameAllowed(clean)) return clean;
  const own = kept === undefined ? '' : normalizeName(kept);
  return own && isNameAllowed(own) ? own : randomName();
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

const write = (stored: StoredPlayer, onError?: (error: unknown) => void) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    return true;
  } catch (error) {
    console.error('Could not save player identity', error);
    onError?.(error);
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

/**
 * The ticket count past the last number this tab took, and its key. A refused write, or another tab's
 * late write of a lower count, can leave storage behind it; this tab never goes back below it.
 */
let taken: { secretKey: string; nextNonce: number } | null = null;

let lastKey: { secretKeyHex: string; publicKey: Uint8Array } | null = null;

const toPlayer = (s: StoredPlayer): Player => {
  const secretKey = fromHex(s.secretKey);
  if (lastKey?.secretKeyHex !== s.secretKey) lastKey = { secretKeyHex: s.secretKey, publicKey: publicKeyFromSecret(secretKey) };
  const { publicKey } = lastKey;
  return { name: s.name, secretKey, publicKey, publicKeyHex: toHex(publicKey), fingerprint: fingerprint(publicKey) };
};

/**
 * The record with its ticket counter past every ticket its key's pack history records. A pack's mapping
 * can be stored while the counter write past it was refused (storage full, then a reload): that ticket
 * is spent, so it is counted, never handed out again. The next claim stores the repaired count.
 */
const pastRecorded = (record: StoredPlayer): StoredPlayer => {
  const recorded = ticketsRecorded(toPlayer(record).publicKeyHex);
  return recorded > record.nextNonce ? { ...record, nextNonce: recorded } : record;
};

/** current(), with the ticket counter past every number this tab took or the history records for the same key. */
const forTickets = (): StoredPlayer => {
  const record = pastRecorded(current());
  return taken?.secretKey === record.secretKey && taken.nextNonce > record.nextNonce ? { ...record, nextNonce: taken.nextNonce } : record;
};

export const getPlayer = (): Player => toPlayer(current());

/** The ticket number the next pack will use (without consuming it). */
export const peekNonce = (): number => forTickets().nextNonce;

/**
 * Changed by every save-file import and move, before either writes an incoming value, so a tab that
 * loaded the save from before can tell even when the same player comes back.
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

/** Refusal when storage changed to a different player or import before a ticket could be claimed. */
export class StaleSaveError extends Error {
  constructor(message = 'Save changed before ticket could be claimed') {
    super(message);
    this.name = 'StaleSaveError';
  }
}

/** The player and how many tickets it has used, read from one record so neither belongs to another key. */
export const getPlayerTickets = (): { player: Player; nextNonce: number } => {
  const record = pastRecorded(current());
  return { player: toPlayer(record), nextNonce: record.nextNonce };
};

/**
 * A ticket number handed out, with the player it belongs to (read from the same record, so a pack
 * never pairs one key with another key's nonce). `stored` is false when storage refused the new
 * count: this tab won't hand the number out again, but after a reload it could be, so warn.
 */
export interface NonceClaim {
  nonce: number;
  player: Player;
  stored: boolean;
}

/** Logged when a claim fails because this player's ticket counter is out of safe integers. */
export const COUNTER_EXHAUSTED = 'Ticket counter exhausted: this player has no ticket number with a safe successor left';

const take = (record: StoredPlayer, nonce: number): NonceClaim => {
  // Checked before anything is written: a count past Number.MAX_SAFE_INTEGER would make the next read
  // reject the record and make a new key in its place.
  if (!Number.isSafeInteger(nonce + 1)) throw new RangeError('This player has no ticket numbers left');
  const next = { ...record, nextNonce: nonce + 1 };
  memory = next;
  taken = { secretKey: next.secretKey, nextNonce: next.nextNonce };
  return { nonce, player: toPlayer(next), stored: write(next) };
};

/** Consume the next ticket number from this tab's view of storage. Prefer claimNonce(). */
export const allocateNonce = (expectedSave?: SaveMark): NonceClaim => {
  if (expectedSave && !sameSave(expectedSave, saveMark())) throw new StaleSaveError();
  const record = forTickets();
  if (expectedSave && !sameSave(expectedSave, saveMark())) throw new StaleSaveError();
  return take(record, record.nextNonce);
};

const CLAIM_TRIES = 1000;
const LOCK_PREFIX = 'brainrot-ticket:';
/** How long a claim waits for the key's lock before counting on alone: a hung tab could hold it forever. */
const LOCK_WAIT_MS = 5000;

/**
 * The lock this tab holds for the highest number it took under each key, and how to let it go. Only
 * that one is kept: attempt() never takes a number at or below a held lock's, so it covers the ones before it.
 */
const heldLocks = new Map<string, { nonce: number; release: () => void }>();

const keepLock = (key: string, nonce: number, release: () => void) => {
  const top = heldLocks.get(key);
  if (top && top.nonce > nonce) return release();
  heldLocks.set(key, { nonce, release });
  top?.release();
};

/**
 * One past the highest number from `nonce` on that any tab holds a lock for under `key`; `nonce` when
 * none. Without query() (no browser with Web Locks lacks it, but a stand-in might), `nonce` as is: the
 * number locks alone then turn a claim away only from the number each tab still holds (its highest), so
 * a tab whose storage view lags could take a lower number that another tab took and has let go.
 */
const pastHeldLocks = async (locks: LockManager, key: string, nonce: number): Promise<number> => {
  if (typeof locks.query !== 'function') return nonce;
  const prefix = `${LOCK_PREFIX}${key}:`;
  const { held = [] } = await locks.query();
  let next = nonce;
  for (const { name } of held) {
    const other = name?.startsWith(prefix) ? Number(name.slice(prefix.length)) : NaN;
    if (Number.isSafeInteger(other + 1) && other >= nonce) next = Math.max(next, other + 1);
  }
  return next;
};

/**
 * One turn at claiming a number for `record`'s key, from `at.nonce` (moved past every number a tab holds).
 * Claims for a key take turns across tabs under one lock, and a number's lock is let go before the turn
 * ends unless the claim took it, so every number lock another claim sees held is a number some tab took:
 * skipping past it never leaves a number unused (an unused number would leave a gap in the history a
 * profile proof covers). Takes the number if no tab holds its lock and storage hasn't moved past it;
 * otherwise resolves with the next number worth trying. Rejects if the key's lock isn't granted within
 * LOCK_WAIT_MS.
 */
const attempt = (locks: LockManager, record: StoredPlayer, at: { nonce: number }, expectedSave?: SaveMark) => {
  const key = toPlayer(record).publicKeyHex;
  const wait = new AbortController(); // not AbortSignal.timeout(), which some browsers with Web Locks lack
  const timer = setTimeout(() => wait.abort(), LOCK_WAIT_MS);
  return locks.request(`${LOCK_PREFIX}${key}`, { mode: 'exclusive', signal: wait.signal }, async (): Promise<NonceClaim | number> => {
    if (expectedSave && !sameSave(expectedSave, saveMark())) throw new StaleSaveError();
    const nonce = at.nonce = await pastHeldLocks(locks, key, at.nonce);
    let claim: NonceClaim | undefined;
    let staleError: Error | undefined;
    await new Promise<void>((resolve, reject) => {
      locks.request(`${LOCK_PREFIX}${key}:${nonce}`, { ifAvailable: true }, (lock) => {
        if (!lock) return undefined;
        // Storage is checked again now that the number's lock is held, in the task it was granted in.
        // Not query() again: that would wait with the lock held, and an older build's tab (which claims
        // without the key's lock) turned away from this number meanwhile takes the next one, so skipping
        // past that would leave this one unused.
        const now = forTickets();
        if (expectedSave && !sameSave(expectedSave, saveMark())) {
          staleError = new StaleSaveError();
          resolve();
          return undefined;
        }
        if (now.secretKey !== record.secretKey || now.nextNonce > nonce) return undefined;
        claim = take(now, nonce);
        resolve();
        // Held until this tab takes a higher number for the key, or closes, so a tab whose storage view is
        // behind can never take this number (or, through pastHeldLocks, one below it).
        return new Promise<void>((release) => keepLock(key, nonce, () => release()));
      }).then(() => resolve(), reject); // a lock not kept is let go first
    });
    if (staleError) throw staleError;
    return claim ?? nonce + 1;
  }).finally(() => clearTimeout(timer));
};

/**
 * The unlocked fallback: the first number from `nonce` on that storage hasn't passed, so a number this
 * claim already tried and saw taken is never handed out. Another key's record starts from its own count.
 */
const takeFrom = (record: StoredPlayer, nonce: number, expectedSave?: SaveMark): NonceClaim => {
  if (expectedSave && !sameSave(expectedSave, saveMark())) throw new StaleSaveError();
  const now = forTickets();
  if (expectedSave && !sameSave(expectedSave, saveMark())) throw new StaleSaveError();
  return take(now, now.secretKey === record.secretKey ? Math.max(nonce, now.nextNonce) : now.nextNonce);
};

/**
 * Consume the next ticket number, safely across tabs: each number is claimed under a Web Lock named
 * for the key and number, because another tab's view of localStorage can lag behind, and claims for a
 * key take turns under a lock named for the key. Each tab holds the lock of the highest number it took
 * under a key for the life of the tab, and lets the lower ones go. Where Web Locks are missing or fail
 * (insecure pages, old browsers), or the key's lock stays held past LOCK_WAIT_MS, this counts on in this
 * tab alone, from the number it reached.
 */
export const claimNonce = async (expectedSave?: SaveMark): Promise<NonceClaim> => {
  if (expectedSave && !sameSave(expectedSave, saveMark())) throw new StaleSaveError();
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (typeof locks?.request !== 'function') return allocateNonce(expectedSave);
  let record = forTickets();
  const at = { nonce: record.nextNonce };
  for (let tries = 0; tries < CLAIM_TRIES; tries++) {
    if (expectedSave && !sameSave(expectedSave, saveMark())) throw new StaleSaveError();
    let result: NonceClaim | number;
    try {
      result = await attempt(locks, record, at, expectedSave);
    } catch (error) {
      if (error instanceof StaleSaveError) throw error;
      // take() refuses a number with no safe successor with a RangeError: the counter has run out, and
      // the unlocked fallback refuses it the same way, so say that rather than blame the lock.
      console.error(error instanceof RangeError ? COUNTER_EXHAUSTED : 'Could not hold a ticket number', error);
      if (expectedSave && !sameSave(expectedSave, saveMark())) throw new StaleSaveError();
      return takeFrom(record, at.nonce, expectedSave);
    }
    if (typeof result !== 'number') return result;
    if (expectedSave && !sameSave(expectedSave, saveMark())) throw new StaleSaveError();
    const now = forTickets();
    // Another key was switched in: start from its counter, never mixing the two.
    at.nonce = now.secretKey !== record.secretKey ? now.nextNonce : Math.max(result, now.nextNonce);
    record = now;
  }
  return takeFrom(record, at.nonce, expectedSave);
};

/**
 * What a rename did, with the player as it is now stored: `saved`; `blank`, `unchanged` or `blocked`
 * (a name other players aren't shown, see isNameAllowed; nothing written); or `failed` (this browser refused the write, so the old name stays). `stale` means the
 * stored player is no longer the one the rename was meant for (another tab switched or imported a
 * save), so nothing was written and that player isn't handed back.
 */
export type RenameResult =
  | { status: 'saved' | 'blank' | 'unchanged' | 'blocked' | 'failed'; player: Player }
  | { status: 'stale' };

/**
 * Change only the name, on the record read from storage now, so another tab's key and ticket counter
 * stay intact. `expectedKey` is the public key (hex) of the player being renamed: if the stored player
 * has another key, nothing is written, so one player's name never lands on another player.
 */
export const renamePlayer = (name: string, expectedKey: string): RenameResult => {
  const clean = normalizeName(name);
  const record = current();
  const player = toPlayer(record);
  if (player.publicKeyHex !== expectedKey) return { status: 'stale' };
  if (!clean) return { status: 'blank', player };
  if (!isNameAllowed(clean)) return { status: 'blocked', player };
  if (clean === record.name) return { status: 'unchanged', player };
  const next = { ...record, name: clean };
  // Adopt the name only once it is stored, so the page never shows a name the next read would undo.
  if (!write(next)) return { status: 'failed', player };
  memory = next;
  return { status: 'saved', player: toPlayer(next) };
};

/** For save export/import. The secret key is what makes pulls yours, so treat the export as private. */
export const exportPlayer = (): string => JSON.stringify(forTickets());

/**
 * How many ticket numbers a stored player record (its raw value) has used, counting past every ticket
 * the pack history records for its key, as claims do; null when it isn't a valid record.
 */
export const ticketCount = (raw: string): number | null => {
  const record = parsePlayer(raw);
  return record && pastRecorded(record).nextNonce;
};

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

/**
 * A stored player record (its raw value) moving in from elsewhere, with a name other players may be
 * shown: unchanged when its name is allowed or the record isn't valid, else with a random name.
 */
export const withAllowedName = (raw: string): string => {
  const record = parsePlayer(raw);
  if (!record || isNameAllowed(normalizeName(record.name))) return raw;
  return JSON.stringify({ ...record, name: importedName(record.name) });
};

/** Whether `secretKey` is this browser's player, without creating one. */
export const isCurrentPlayer = (secretKey: string): boolean => (read() ?? memory)?.secretKey === secretKey;

/**
 * Stores this tab's ticket count again when another tab's write left a lower one for the same key
 * (two tabs' writes can land out of order), so the count outlasts this tab. Another key, or a removed
 * record, is left alone. False when the count needed storing and storage refused it.
 */
const keepTicketCount = (): boolean => {
  const fresh = read();
  if (!fresh || !taken || fresh.secretKey !== taken.secretKey || fresh.nextNonce >= taken.nextNonce) return true;
  return write({ ...fresh, nextNonce: taken.nextNonce });
};

/**
 * Calls `onChange` when another tab stores a player record (an import, a switch, a rename), imports a
 * save, or clears this browser's storage, so a tab can find out that its save changed before it next
 * writes. The storage event only reaches other tabs, and can arrive late: writers still compare
 * saveMark() themselves. While watching, it also keeps the stored ticket count from going below this
 * tab's (see keepTicketCount), and calls `onCountRefused` when storage refuses that. Returns the
 * unsubscribe.
 */
export const watchPlayer = (onChange: () => void, onCountRefused?: () => void): (() => void) => {
  const listener = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY && !keepTicketCount()) onCountRefused?.();
    if (event.key === null || event.key === STORAGE_KEY || event.key === SAVE_STAMP_KEY) onChange();
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
};

/**
 * Like watchPlayer, for a view that only needs to know when the stored player may have changed
 * (a share sheet): it never writes, so it cannot touch the ticket count or raise its refusal.
 */
export const watchStoredPlayer = (onChange: () => void): (() => void) => {
  const listener = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY || event.key === SAVE_STAMP_KEY) onChange();
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
};

/** `onWriteError` hears why storage refused the identity (a full storage, say), when it did. */
export const importPlayer = (raw: string, onWriteError?: (error: unknown) => void): boolean => {
  const incoming = parsePlayer(raw);
  if (!incoming) return false;
  try {
    // Import must not create a guest or replace the memory fallback until the key is durable.
    const existing = read() ?? memory;
    const next = {
      ...incoming,
      name: importedName(incoming.name, existing?.secretKey === incoming.secretKey ? existing.name : undefined),
      // Never move the ticket counter backwards for the same key (that would replay old packs).
      nextNonce: existing?.secretKey === incoming.secretKey ? Math.max(existing.nextNonce, incoming.nextNonce) : incoming.nextNonce,
    };
    if (!write(next, onWriteError)) return false;
    memory = next;
    return true;
  } catch {
    return false;
  }
};
