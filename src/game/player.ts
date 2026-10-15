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

export const renamePlayer = (name: string): Player => {
  const clean = normalizeName(name);
  if (!clean) return getPlayer();
  return toPlayer(update((s) => ({ ...s, name: clean })));
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
