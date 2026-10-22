/**
 * Packs this device has re-opened while checking someone's profile, so a second look (or the same
 * profile with more packs) only re-opens what's new. Only ever written with packs this device
 * derived itself, so trusting it is trusting this device.
 */
import { setKey, type PulledCard, type SetDefinition } from '../engine';
import { decodeCard, encodeCard, modifiersFor } from './cardCode';

export const REOPEN_CACHE_KEY = 'brainrot-reopened-v1';
export const MAX_REOPEN_CACHE_ENTRIES = 5000;

let memory: Map<string, string> | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export const resetReopenCache = () => {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  memory = null;
  dirty = false;
};

const load = (): Map<string, string> => {
  if (memory) return memory;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(REOPEN_CACHE_KEY) : null;
    memory = new Map(Object.entries(JSON.parse(raw ?? '{}') as Record<string, string>));
  } catch {
    memory = new Map();
  }
  return memory;
};

export const flush = () => {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (!dirty || !memory) return;
  dirty = false;
  while (memory.size > MAX_REOPEN_CACHE_ENTRIES) memory.delete(memory.keys().next().value!);
  try {
    localStorage.setItem(REOPEN_CACHE_KEY, JSON.stringify(Object.fromEntries(memory)));
  } catch {
    // Storage denied or quota exceeded: it's only a cache.
    // Retain bounded memory-only fallback and attempt best-effort removal.
    try {
      localStorage.removeItem(REOPEN_CACHE_KEY);
    } catch {
      // Storage access completely denied: do not let removal failure escape the timer.
    }
  }
};

const keyOf = (set: SetDefinition, publicKeyHex: string, nonce: number) => `${setKey(set)}|${publicKeyHex}|${nonce}`;

export const getReopened = (set: SetDefinition, publicKeyHex: string, nonce: number): PulledCard[] | null => {
  const stored = load().get(keyOf(set, publicKeyHex, nonce));
  if (!stored) return null;
  const cards = stored.split(',').map((text, slot) => {
    const c = decodeCard(text);
    // This exact version's rarity: a later version may change it (spec section 12).
    const rarity = set.cards.find((card) => card.id === c.id)?.rarity;
    return rarity ? { setId: set.id, cardId: c.id, rarity, isHolo: c.holo, ...modifiersFor(c, set.modifiers === 1), slot } : null;
  });
  return cards.every((c) => c) ? (cards as PulledCard[]) : null;
};

export const putReopened = (set: SetDefinition, publicKeyHex: string, nonce: number, cards: readonly PulledCard[]) => {
  const map = load();
  const key = keyOf(set, publicKeyHex, nonce);
  map.delete(key); // re-insert as newest
  map.set(key, cards.map((c) => encodeCard({ id: c.cardId, holo: c.isHolo, finish: c.finish, misprint: c.misprint })).join(','));
  while (map.size > MAX_REOPEN_CACHE_ENTRIES) map.delete(map.keys().next().value!);
  dirty = true;
  flushTimer ??= setTimeout(flush, 1000);
};
