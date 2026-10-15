/**
 * Every pack opened on this device, newest first. Each entry keeps the set, version and ticket
 * number, which is all it takes to re-derive the pack (and to prove it in a profile); the cards,
 * hand and score are a cache for showing it without mining the ticket again.
 *
 * Stored compactly: thousands of packs fit comfortably in localStorage.
 */
import { STORAGE_KEYS } from '../constants';
import { POKER_HANDS, qualifiesForHallOfFame, type Finish } from '../engine';
import { decodeCard, encodeCard, type StoredCard } from './cardCode';
import { getStoredPack } from './packStore';
import type { OpenedPack } from './pulls';

export interface HistoryEntry {
  setId: string;
  setVersion: number;
  nonce: number;
  /** First 16 hex characters of the key that opened it (profiles only list the current key's packs). */
  key: string;
  /** Null for packs carried over from the old notable-pulls log, which didn't keep cards. */
  cards: StoredCard[] | null;
  hand: string;
  score: number;
  openedAt: number;
}

/** On-disk shape: short field names, cards as "id,id*,id" (`*` = holo). */
interface Stored {
  s: string;
  v: number;
  n: number;
  k: string;
  c?: string;
  h: string;
  x: number;
  t: number;
}

const KEY_PREFIX = 16;

const encode = (e: HistoryEntry): Stored => ({
  s: e.setId,
  v: e.setVersion,
  n: e.nonce,
  k: e.key,
  ...(e.cards ? { c: e.cards.map(encodeCard).join(',') } : {}),
  h: e.hand,
  x: e.score,
  t: e.openedAt,
});

/** Cards dropped to save space (or never kept) come back from the packs this device re-opened. */
const cardsOf = (s: Stored): StoredCard[] | null => {
  const code = s.c || getStoredPack(`${s.s}@${s.v}`, s.k, s.n);
  return code ? code.split(',').map(decodeCard) : null;
};

const decode = (s: Stored): HistoryEntry => ({
  setId: s.s,
  setVersion: s.v,
  nonce: s.n,
  key: s.k,
  cards: cardsOf(s),
  hand: s.h,
  score: s.x,
  openedAt: s.t,
});

const read = (): Stored[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.HISTORY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const save = (entries: Stored[]) => {
  try {
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(entries));
    return true;
  } catch {
    return false;
  }
};

/**
 * Out of space: first drop the cached cards of the oldest packs (the ticket is enough to re-derive
 * them), halving how many keep cards until it fits; only then drop the oldest packs themselves.
 */
const write = (entries: Stored[]) => {
  if (save(entries)) return;
  for (let withCards = Math.floor(entries.length / 2); ; withCards = Math.floor(withCards / 2)) {
    if (save(entries.map((e, i) => (i < withCards ? e : { ...e, c: undefined })))) return;
    if (withCards === 0) break;
  }
  const bare = entries.map((e) => ({ ...e, c: undefined }));
  for (let keep = Math.floor(bare.length / 2); keep > 0; keep = Math.floor(keep / 2)) {
    if (save(bare.slice(0, keep))) return;
  }
  console.error('Could not save pack history');
};

const sameTicket = (a: Stored, b: Stored) => a.k === b.k && a.n === b.n;

/** Newest first. */
export const getHistory = (): HistoryEntry[] => read().map(decode);

/** Good enough for the Hall of Fame (the same rule as its Submit button). */
export const isHallOfFameWorthy = (entry: Pick<HistoryEntry, 'hand' | 'score'>): boolean => {
  const hand = Object.values(POKER_HANDS).find((h) => h.name === entry.hand) ?? POKER_HANDS.NO_MATCH;
  return qualifiesForHallOfFame({ points: 0, hand, score: entry.score });
};

/** Highest score first; the newest first among equal scores. */
export const byBest = (a: HistoryEntry, b: HistoryEntry): number => b.score - a.score || b.openedAt - a.openedAt;

export const recordPack = (pack: OpenedPack) => {
  const entry = encode({
    setId: pack.setId,
    setVersion: pack.setVersion,
    nonce: pack.nonce,
    key: (pack.publicKeyHex ?? '').slice(0, KEY_PREFIX),
    cards: pack.cards.map((c) => ({ id: c.id, holo: c.isHolo, finish: c.finish, misprint: c.misprint })),
    hand: pack.score.hand.name,
    score: pack.score.score,
    openedAt: pack.openedAt,
  });
  write([entry, ...read().filter((e) => !sameTicket(e, entry))]);
};

/** This key's packs in ticket order (what a profile is built from). */
export const historyForKey = (publicKeyHex: string): HistoryEntry[] =>
  getHistory()
    .filter((e) => e.key === publicKeyHex.slice(0, KEY_PREFIX))
    .sort((a, b) => a.nonce - b.nonce);

/** One-time: bring entries from the old notable-pulls log (no cards) into the history. */
export const migratePullLog = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PULLS);
    if (!raw) return;
    const old = JSON.parse(raw) as { setId: string; setVersion: number; nonce: number; publicKeyHex?: string; score: number; hand: string; openedAt: number }[];
    const current = read();
    const carried = (Array.isArray(old) ? old : [])
      .filter((p) => p.publicKeyHex)
      .map((p) =>
        encode({ setId: p.setId, setVersion: p.setVersion, nonce: p.nonce, key: p.publicKeyHex!.slice(0, KEY_PREFIX), cards: null, hand: p.hand, score: p.score, openedAt: p.openedAt }),
      )
      .filter((e) => !current.some((c) => sameTicket(c, e)));
    write([...current, ...carried].sort((a, b) => b.t - a.t));
    localStorage.removeItem(STORAGE_KEYS.PULLS);
  } catch {
    // Unreadable old log: nothing to carry over.
  }
};

/**
 * This key's most recent pack holding this card, so a card can be shared with the pull that proves
 * it: one with this exact version if there is one, else one with the same holo, else any.
 */
export const findPackWithCard = (
  publicKeyHex: string,
  setId: string,
  cardId: string,
  version: { isHolo: boolean; finish?: Finish | null; misprint?: boolean } = { isHolo: false },
): HistoryEntry | null => {
  const mine = getHistory().filter((e) => e.setId === setId && e.cards && publicKeyHex.startsWith(e.key));
  const exact = (c: StoredCard) => c.holo === version.isHolo && (c.finish ?? null) === (version.finish ?? null) && !!c.misprint === !!version.misprint;
  const has = (test: (c: StoredCard) => boolean) => mine.find((e) => e.cards!.some((c) => c.id === cardId && test(c)));
  return has(exact) ?? has((c) => c.holo === version.isHolo) ?? has(() => true) ?? null;
};

/**
 * The pack with exactly these cards (in order, with holo, finish and misprint), opened nearest to
 * `at`, for records that kept a pack's cards but not its ticket. Within six hours, since the same
 * five cards can come up twice.
 */
export const findPackByCards = (cards: readonly StoredCard[], setId: string, at: number): HistoryEntry | null => {
  const want = cards.map(encodeCard).join(',');
  let best: HistoryEntry | null = null;
  for (const e of getHistory()) {
    if (e.setId !== setId || !e.cards || Math.abs(e.openedAt - at) > 6 * 3600_000) continue;
    if (e.cards.map(encodeCard).join(',') !== want) continue;
    if (!best || Math.abs(e.openedAt - at) < Math.abs(best.openedAt - at)) best = e;
  }
  return best;
};
