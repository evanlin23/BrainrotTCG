/**
 * Packs this device has re-opened while checking someone's profile, so a second look (or the same
 * profile with more packs) only re-opens what's new. Only ever written with packs this device
 * derived itself, so trusting it is trusting this device.
 */
import { setKey, type PulledCard, type SetDefinition } from '../engine';
import { decodeCards, encodeCard, modifiersFor } from './cardCode';

export const REOPEN_CACHE_KEY = 'brainrot-reopened-v1';
export const MAX_REOPEN_CACHE_ENTRIES = 5000;

let memory: Map<string, string> | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
// Set after the first failed write: the cache stays memory-only for the rest of the session, so it
// never rewrites itself into room a save needs.
let memoryOnly = false;

/** Test-only: forget the in-memory map, pending flush and memory-only state. */
export const __resetReopenCacheForTests = () => {
  stopWaiting();
  memory = null;
  dirty = false;
  memoryOnly = false;
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

// A write waits up to a second to batch a profile's packs, but a tab closed (or a phone app switched
// away) in that second runs no more timers: the page going hidden or away writes it at once instead.
const flushWhenHidden = () => {
  if (document.visibilityState === 'hidden') flushReopenCache();
};

const stopWaiting = () => {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  if (typeof window === 'undefined') return;
  window.removeEventListener('pagehide', flushReopenCache);
  document.removeEventListener('visibilitychange', flushWhenHidden);
};

/**
 * Write a pending change now instead of on its timer, so nothing is left to run (or lost) once the page
 * or the app that made it is gone. A no-op with nothing pending.
 */
export const flushReopenCache = () => {
  stopWaiting();
  if (!dirty || !memory || memoryOnly) return;
  dirty = false;
  while (memory.size > MAX_REOPEN_CACHE_ENTRIES) memory.delete(memory.keys().next().value!);
  try {
    localStorage.setItem(REOPEN_CACHE_KEY, JSON.stringify(Object.fromEntries(memory)));
  } catch {
    // Storage denied or quota exceeded: it's only a cache. Give the space back to saves and stay
    // memory-only (still capped at MAX_REOPEN_CACHE_ENTRIES) until the page reloads.
    memoryOnly = true;
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
  const decoded = decodeCards(stored);
  if (!decoded) return null;
  const cards = decoded.map((c, slot) => {
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
  if (memoryOnly || flushTimer) return;
  flushTimer = setTimeout(flushReopenCache, 1000);
  if (typeof window === 'undefined') return;
  window.addEventListener('pagehide', flushReopenCache);
  document.addEventListener('visibilitychange', flushWhenHidden);
};
