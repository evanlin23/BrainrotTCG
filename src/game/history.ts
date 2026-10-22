/**
 * Every pack opened on this device, newest first. Each entry keeps the set, version and ticket
 * number, which is all it takes to re-derive the pack (and to prove it in a profile); the cards,
 * hand and score are a cache for showing it without mining the ticket again.
 *
 * Stored compactly: thousands of packs fit comfortably in localStorage.
 */
import { STORAGE_KEYS } from '../constants';
import { POKER_HANDS, qualifiesForHallOfFame, scorePulled, type Finish } from '../engine';
import { getSet } from '../content/sets';
import { decodeCard, encodeCard, toPulled, type StoredCard } from './cardCode';
import { getStoredPack, packStoreVersion } from './packStore';
import type { OpenedPack } from './pulls';
import type { CardWithMeta } from '../components/cards/Card';
import { getCard } from '../data/cards';

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

/** recordTicket's stand-in: no cards, hand or score yet (every pack has a hand). */
const isTicketOnly = (e: Stored) => e.h === '' && e.c === undefined;

/**
 * A stand-in's hand and score, from its pack's cards once this device has re-opened it (a profile
 * does), so Best, For Rankings and achievements count it like any pack. Worked out on each read and
 * never written: the stand-in stays as stored until recordPack or recordMissing replaces it.
 */
const handOf = (s: Stored, cards: StoredCard[] | null): Pick<HistoryEntry, 'hand' | 'score'> => {
  const set = isTicketOnly(s) && cards ? getSet(s.s, s.v) : undefined;
  const pulled = set && cards ? toPulled(cards, set) : null;
  if (!pulled) return { hand: s.h, score: s.x };
  const { hand, score } = scorePulled(pulled);
  return { hand: hand.name, score };
};

const decode = (s: Stored): HistoryEntry => {
  const cards = cardsOf(s);
  return { setId: s.s, setVersion: s.v, nonce: s.n, key: s.k, cards, ...handOf(s, cards), openedAt: s.t };
};

const rawHistory = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEYS.HISTORY);
  } catch {
    return null;
  }
};

/** The stored history as saved (null when unreadable): equal strings mean an unchanged history. */
export const storedHistory = (): string | null => rawHistory();

const parseHistory = (raw: string | null): Stored[] => {
  try {
    const parsed = JSON.parse(raw ?? '[]');
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
 * Out of space: drop only reconstructible cached cards. Original ticket-to-set mappings
 * are irreplaceable; if even their bare representation cannot fit, keep the previous raw log.
 */
const write = (entries: Stored[]): boolean => {
  if (save(entries)) return true;
  for (let withCards = Math.floor(entries.length / 2); ; withCards = Math.floor(withCards / 2)) {
    if (save(entries.map((e, i) => (i < withCards ? e : { ...e, c: undefined })))) return true;
    if (withCards === 0) break;
  }
  console.error('Could not save pack history');
  return false;
};

const sameTicket = (a: Stored, b: Stored) => a.k === b.k && a.n === b.n;
const sameAssignment = (a: Stored, b: Stored) => sameTicket(a, b) && a.s === b.s && a.v === b.v;

const assignmentOf = (e: Stored) => JSON.stringify([e.k, e.n, e.s, e.v]);

/**
 * A stand-in stored beside its own pack's full entry, or beside another stand-in for it (an imported
 * backup or an older build kept both), is the same pack, so it is listed once, as recordPack or
 * recordMissing will store it: in the first stand-in's place with that stand-in's time (replaceStandIn),
 * filled by the pack's full entry if there is one, so a profile's firstOpened picks the same ticket
 * before and after. Read-side only: the stored history stays as it is until then.
 */
const withoutSpareStandIns = (entries: Stored[]): Stored[] => {
  const stubs = new Set(entries.filter(isTicketOnly).map(assignmentOf));
  if (stubs.size === 0) return entries;
  // The first full entry stored for each assignment that also has a stand-in. Every copy is the same
  // pack; the history is kept newest first and a full store drops cards from the end (write), so the
  // first is the likeliest to still carry its cards.
  const full = new Map<string, Stored>();
  for (const e of entries) {
    const a = assignmentOf(e);
    if (!isTicketOnly(e) && stubs.has(a) && !full.has(a)) full.set(a, e);
  }
  const listed = new Set<string>();
  return entries.flatMap((e) => {
    const a = assignmentOf(e);
    if (!stubs.has(a)) return [e];
    if (listed.has(a) || !isTicketOnly(e)) return [];
    listed.add(a);
    const pack = full.get(a);
    return [pack ? fillStandIn(e, pack) : e];
  });
};

/** getHistory's entries, with the stored history and pack-store version they were decoded from. */
let decoded: { raw: string | null; packs: number; entries: readonly HistoryEntry[] } | null = null;

/**
 * Newest first. Decoded again only when the stored history or the re-opened packs change, so a pack
 * open's many readers share one decode. Each call reads the stored history, so another tab's write
 * is never missed.
 */
export const getHistory = (): readonly HistoryEntry[] => {
  const raw = rawHistory();
  const packs = packStoreVersion();
  if (decoded?.raw !== raw || decoded.packs !== packs) {
    decoded = { raw, packs, entries: withoutSpareStandIns(parseHistory(raw)).map(decode) };
  }
  return decoded.entries;
};

/** A pack's cards as the app shows them, or null if the history has none for it. */
export const historyCards = (entry: HistoryEntry): CardWithMeta[] | null =>
  entry.cards
    ?.map((c, i): CardWithMeta | null => {
      const card = getCard(`${entry.setId}/${c.id}`);
      if (!card) return null;
      const meta: CardWithMeta = { ...card, uniqueId: i, isRevealed: true, isHolo: c.holo };
      if (c.finish) meta.finish = c.finish;
      if (c.misprint) meta.misprint = true;
      return meta;
    })
    .filter((c): c is CardWithMeta => c !== null) ?? null;

/** Good enough for the Hall of Fame (the same rule as its Submit button). */
export const isHallOfFameWorthy = (entry: Pick<HistoryEntry, 'hand' | 'score'>): boolean => {
  const hand = Object.values(POKER_HANDS).find((h) => h.name === entry.hand) ?? POKER_HANDS.NO_MATCH;
  return qualifiesForHallOfFame({ points: 0, hand, score: entry.score });
};

/** Highest score first; the newest first among equal scores. */
export const byBest = (a: HistoryEntry, b: HistoryEntry): number => b.score - a.score || b.openedAt - a.openedAt;

/** The stored history, or null when an entry breaks the rule (a write would drop it) or it can't be read. */
const readValid = (): Stored[] | null => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.HISTORY) ?? '[]');
    return Array.isArray(parsed) && parsed.every(isStored) ? parsed : null;
  } catch { return null; }
};

const toStored = (pack: OpenedPack): Stored => encode({
  setId: pack.setId,
  setVersion: pack.setVersion,
  nonce: pack.nonce,
  key: (pack.publicKeyHex ?? '').slice(0, KEY_PREFIX),
  cards: pack.cards.map((c) => ({ id: c.id, holo: c.isHolo, finish: c.finish, misprint: c.misprint })),
  hand: pack.score.hand.name,
  score: pack.score.score,
  openedAt: pack.openedAt,
});

/**
 * A pack in its recordTicket stand-in's place, keeping the stand-in's time: it sorts where the stand-in
 * did, newest first here and by openedAt everywhere else, so the history doesn't reorder when it opens.
 */
const fillStandIn = (stub: Stored, entry: Stored): Stored => ({ ...entry, t: stub.t });

/**
 * The history with the stand-in at `stub` filled by `entry`, and any other record of the same assignment
 * (a full entry an imported backup carried alongside the stand-in) dropped, so the pack is listed once.
 * Another set on the same ticket is a different assignment and stays.
 */
const replaceStandIn = (current: readonly Stored[], stub: number, entry: Stored): Stored[] =>
  current.flatMap((e, i) => (i === stub ? [fillStandIn(e, entry)] : sameAssignment(e, entry) ? [] : [e]));

export const recordPack = (pack: OpenedPack): boolean => {
  const current = readValid();
  if (!current) return false;
  const entry = toStored(pack);
  /*
   * Re-recording a pack replaces its entry. Another set on the same ticket is a conflicting
   * assignment (two tabs spent one ticket number at once, or an imported backup carried both).
   * Neither record can be rebuilt from the other, so both are kept rather than the last one
   * winning; a profile admits one of them by a fixed rule (firstOpened below).
   */
  const stub = current.findIndex((e) => sameAssignment(e, entry) && isTicketOnly(e));
  if (stub >= 0) return write(replaceStandIn(current, stub, entry));
  return write([entry, ...current.filter((e) => !sameAssignment(e, entry))]);
};

/**
 * Records that this key spent ticket `nonce` on `set@version` before its pack is in hand: a mapping with
 * no cards, hand or score, which recordPack (or recordMissing) replaces once the pack opens. If the pack
 * never opens here (its ticket fails to mine, or the tab closes), a profile still covers the ticket and
 * re-opens it to show it. False when the history can't be read or written.
 */
export const recordTicket = (setId: string, setVersion: number, nonce: number, publicKeyHex: string, openedAt: number): boolean => {
  const current = readValid();
  if (!current) return false;
  const entry: Stored = { s: setId, v: setVersion, n: nonce, k: publicKeyHex.slice(0, KEY_PREFIX), h: '', x: 0, t: openedAt };
  return current.some((e) => sameAssignment(e, entry)) || write([entry, ...current]);
};

/**
 * Records the packs opened with this key whose ticket mapping the history lacks (its write failed when
 * the pack opened, e.g. with storage full), in opening order; recorded ones stay as they are, but a
 * recordTicket stand-in gives way to its pack. App calls this once a save goes through, so a lost mapping
 * comes back. Another key's packs (or a pack without one) are left out, so no player's tickets enter
 * another's history. False when the history can't be read or written.
 */
export const recordMissing = (packs: readonly OpenedPack[], publicKeyHex: string): boolean => {
  const mine = packs.filter((pack) => pack.publicKeyHex === publicKeyHex);
  if (mine.length === 0) return true;
  let current = readValid();
  if (!current) return false;
  let added = false;
  for (const pack of mine) {
    const entry = toStored(pack);
    const stub = current.findIndex((e) => sameAssignment(e, entry) && isTicketOnly(e));
    if (stub >= 0) {
      current = replaceStandIn(current, stub, entry);
      added = true;
      continue;
    }
    if (current.some((e) => sameAssignment(e, entry))) continue;
    // Newest first, as recordPack keeps it.
    const at = current.findIndex((e) => e.t < entry.t);
    current.splice(at < 0 ? current.length : at, 0, entry);
    added = true;
  }
  return !added || write(current);
};

type OpenedOrder = Pick<HistoryEntry, 'openedAt' | 'setId' | 'setVersion'>;

/**
 * One original mapping per ticket. History keeps every conflicting record of a ticket (two tabs
 * spent the same ticket number, or a backup carried both; see recordPack), and a profile admits
 * the pack opened first with it: the earliest openedAt, then setId, then setVersion. Every read on
 * every device picks the same record whatever order they are stored in, and none is deleted.
 */
export const firstOpened = (a: OpenedOrder, b: OpenedOrder): number =>
  a.openedAt - b.openedAt || (a.setId < b.setId ? -1 : a.setId > b.setId ? 1 : 0) || a.setVersion - b.setVersion;

/** This key's packs in ticket order (what a profile is built from). */
export const historyForKey = (publicKeyHex: string): HistoryEntry[] =>
  getHistory()
    .filter((e) => e.key === publicKeyHex.slice(0, KEY_PREFIX))
    .sort((a, b) => a.nonce - b.nonce);

/** ticketsRecorded's count per key prefix, with the stored history it was counted from. */
let counted: { raw: string | null; next: Map<string, number> } | null = null;

/**
 * One past the highest ticket this key's history records (0 when none). A recorded ticket was spent
 * even if storage refused the ticket counter past it, so the counter never hands it out again. Never
 * above Number.MAX_SAFE_INTEGER: a ticket number with no safe successor counts for nothing. Counted
 * again only when the stored history changes: each call reads it, so another tab's write is never missed.
 */
export const ticketsRecorded = (publicKeyHex: string): number => {
  const raw = rawHistory();
  if (counted?.raw !== raw) {
    const next = new Map<string, number>();
    for (const e of parseHistory(raw)) {
      if (isStored(e) && Number.isSafeInteger(e.n + 1) && e.n >= (next.get(e.k) ?? 0)) next.set(e.k, e.n + 1);
    }
    counted = { raw, next };
  }
  return counted.next.get(publicKeyHex.slice(0, KEY_PREFIX)) ?? 0;
};

type LegacyPull = Pick<OpenedPack, 'setId' | 'setVersion' | 'nonce' | 'publicKeyHex' | 'openedAt'> & { score: number; hand: string };

/** An entry of the old notable-pulls log that migratePullLog can carry over (save imports use it too). */
export const isLegacyPull = (value: unknown): value is LegacyPull => {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<LegacyPull>;
  return typeof entry.setId === 'string' && entry.setId.length > 0
    && Number.isSafeInteger(entry.setVersion) && entry.setVersion! > 0
    && Number.isSafeInteger(entry.nonce) && entry.nonce! >= 0
    && (entry.publicKeyHex === undefined || typeof entry.publicKeyHex === 'string')
    && typeof entry.hand === 'string' && Number.isFinite(entry.score) && Number.isFinite(entry.openedAt);
};

/** The one rule for a stored history entry: pack writes and save imports both refuse anything else. */
export const isStored = (value: unknown): value is Stored => {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<Stored>;
  return typeof entry.s === 'string' && entry.s.length > 0
    && Number.isSafeInteger(entry.v) && entry.v! > 0
    && Number.isSafeInteger(entry.n) && entry.n! >= 0
    && typeof entry.k === 'string' && (entry.c === undefined || typeof entry.c === 'string')
    && typeof entry.h === 'string' && Number.isFinite(entry.x) && Number.isFinite(entry.t);
};

/** One-time: remove the old log only after every ticket mapping is stored without truncation. */
export const migratePullLog = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PULLS);
    if (!raw) return;
    const old: unknown = JSON.parse(raw);
    const current: unknown = JSON.parse(localStorage.getItem(STORAGE_KEYS.HISTORY) ?? '[]');
    // Keep malformed source data intact rather than replacing it with a partial migration.
    if (!Array.isArray(old) || !old.every(isLegacyPull) || !Array.isArray(current) || !current.every(isStored)) return;
    const merged = [...current];
    for (const pull of old) {
      if (!pull.publicKeyHex) continue; // Older anonymous pulls have no reproducible ticket identity.
      const entry = encode({ ...pull, key: pull.publicKeyHex.slice(0, KEY_PREFIX), cards: null });
      const records = merged.filter((other) => sameTicket(other, entry));
      // Already recorded with this set, alongside any conflicting record (see recordPack).
      if (records.some((other) => sameAssignment(other, entry))) continue;
      // The same ticket cannot prove two sets; preserve conflicting raw logs for recovery.
      if (records.length > 0) return;
      merged.push(entry);
    }
    if (write(merged.sort((a, b) => b.t - a.t))) localStorage.removeItem(STORAGE_KEYS.PULLS);
  } catch {
    // Unreadable or unwritable storage: leave the original log available for recovery or retry.
  }
};

/** Is this stored card exactly this version: the same holo, finish and misprint? */
export const isExactVersion = (c: StoredCard, version: { isHolo: boolean; finish?: Finish | null; misprint?: boolean }): boolean =>
  c.holo === version.isHolo && (c.finish ?? null) === (version.finish ?? null) && !!c.misprint === !!version.misprint;

export interface FindPackOptions {
  /** If true, return only a pack holding the exact version (holo, finish, misprint). No same-holo or any-copy fallback. */
  exactOnly?: boolean;
}

/**
 * This key's most recent pack holding this card, so a card can be shared with the pull that proves
 * it: one with this exact version if there is one, else one with the same holo, else any.
 * When `options.exactOnly` is true, falls back to nothing if the exact version is not in cache.
 */
export const findPackWithCard = (
  publicKeyHex: string,
  setId: string,
  cardId: string,
  version: { isHolo: boolean; finish?: Finish | null; misprint?: boolean } = { isHolo: false },
  options?: FindPackOptions,
): HistoryEntry | null => {
  const mine = getHistory().filter(
    (e) => e.setId === setId && e.cards && publicKeyHex.startsWith(e.key),
  );
  const exact = (c: StoredCard) => isExactVersion(c, version);
  const has = (test: (c: StoredCard) => boolean) => mine.find((e) => e.cards!.some((c) => c.id === cardId && test(c)));
  if (options?.exactOnly) return has(exact) ?? null;
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
