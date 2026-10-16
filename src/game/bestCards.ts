/**
 * Best cards (docs/DESIGN.md, "Local Best cards contract"): each key's 10 strongest single cards, by
 * the card's own points in the set version it was opened from (cardPoints, before the pack's combo
 * multiplier). A card is one instance: the full 64-hex key, set id, set version, ticket number (nonce)
 * and engine slot. Equal points go to the lower nonce, then the higher slot, never to openedAt.
 *
 * Kept in `brainrot-best-cards-v1` as `{ [full key]: { w, b } }`, apart from the pack history, which
 * keeps only a 16-hex key prefix and may drop cached cards when storage is full. Each winner keeps its
 * reference (set, version, nonce, slot) so derivePack can rebuild it from the key alone; its cached
 * card code is a convenience that a rebuild replaces. `w` is the ticket count weighed: the list is the
 * exact top 10 of every ticket below it, so `complete` (certified best) needs `w` to reach the key's
 * ticket count. Lists are per key and never merged across keys.
 */
import { STORAGE_KEYS } from '../constants';
import { getSet } from '../content/sets';
import { cardPoints, computeTicket, derivePack, fromHex, type PulledCard, type TicketFn } from '../engine';
import { decodeCard, encodeCard, toPulled } from './cardCode';
import { firstOpened, historyForKey } from './history';
import type { OpenedPack } from './pulls';

export const BEST_CARDS_CAP = 10;

/** One winner as stored: its reference, the card code cached from it, and when its pack opened. */
interface StoredBest {
  s: string;
  v: number;
  n: number;
  /** Zero-based slot in engine pack order (not reveal order). */
  i: number;
  /** encodeCard of the card; discardable, rebuilt from the reference when missing. */
  c?: string;
  /** openedAt of the pack, only to settle conflicting set assignments for one nonce (firstOpened). */
  t: number;
}

interface StoredList {
  /** Every ticket below this was weighed into `b`. */
  w: number;
  /** At most BEST_CARDS_CAP winners, strongest first, then any that can't be scored here. */
  b: StoredBest[];
}

type Store = Record<string, StoredList>;

export interface BestCard {
  publicKeyHex: string;
  setId: string;
  setVersion: number;
  nonce: number;
  slot: number;
  /** Null when this build can't score it (no cached card, or a set it doesn't know): rebuild to fill. */
  card: PulledCard | null;
  points: number | null;
}

export interface BestCards {
  /** Ranked first; ones that can't be scored here follow, by ticket. */
  cards: BestCard[];
  /** Certified best of every ticket the key used, not just the best among the recoverable ones. */
  complete: boolean;
  /** The latest list couldn't be stored (full or unreadable storage); it's kept in memory and retried. */
  unsaved: boolean;
}

/** A pack offered to the list: its assignment and its cards in engine order. */
export interface BestCandidate {
  setId: string;
  setVersion: number;
  nonce: number;
  openedAt: number;
  cards: readonly PulledCard[];
}

const FULL_KEY = /^[0-9a-f]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isEntry = (e: unknown): e is StoredBest => isRecord(e)
  && typeof e.s === 'string' && e.s !== '' && isCount(e.v) && e.v >= 1 && isCount(e.n) && isCount(e.i)
  && (!('c' in e) || (typeof e.c === 'string' && /^[^,]+$/.test(e.c)))
  && typeof e.t === 'number' && Number.isFinite(e.t) && e.t >= 0;

const instance = (e: Pick<StoredBest, 'n' | 'i'>) => `${e.n}/${e.i}`;

const isList = (value: unknown): value is StoredList => {
  if (!isRecord(value) || !isCount(value.w) || !Array.isArray(value.b) || value.b.length > BEST_CARDS_CAP) return false;
  if (!value.b.every(isEntry)) return false;
  const seen = new Set<string>();
  const sets = new Map<number, string>();
  return value.b.every((e) => {
    const assignment = `${e.s}@${e.v}`;
    if (seen.has(instance(e)) || (sets.get(e.n) ?? assignment) !== assignment) return false;
    seen.add(instance(e));
    sets.set(e.n, assignment);
    return true;
  });
};

/**
 * The stored shape: lists under full 64-hex keys, each at most BEST_CARDS_CAP distinct instances,
 * one set assignment per nonce. Checked before every write and on import (game/saveFile.ts).
 */
export const isBestCardsStore = (value: unknown): value is Store =>
  isRecord(value) && Object.entries(value).every(([key, list]) => FULL_KEY.test(key) && isList(list));

/** Lists this tab couldn't store, by key: shown and merged again until a write goes through. */
const pending = new Map<string, StoredList>();

/** For tests: forget lists held in memory. */
export const resetBestCards = () => pending.clear();

/** {} when nothing is stored yet; null when it can't be read or breaks the rule (never overwritten). */
const readStore = (): { raw: string | null; store: Store } | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.BEST_CARDS);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    return isBestCardsStore(parsed) ? { raw, store: parsed } : null;
  } catch {
    return null;
  }
};

interface Scored {
  entry: StoredBest;
  card: PulledCard | null;
  points: number | null;
}

/** A winner scored by its own set version (a later version can't change it), or unscored. */
const score = (entry: StoredBest): Scored => {
  const set = getSet(entry.s, entry.v);
  const pulled = set && entry.c && entry.i < set.packSize ? toPulled([decodeCard(entry.c)], set)?.[0] : undefined;
  if (!pulled) return { entry, card: null, points: null };
  const card = { ...pulled, slot: entry.i };
  return { entry, card, points: cardPoints(card.rarity, card.isHolo, card.finish, card.misprint) };
};

/** More points first, then the lower nonce, then the higher slot. */
const byRank = (a: Scored, b: Scored) => b.points! - a.points! || a.entry.n - b.entry.n || b.entry.i - a.entry.i;
const byTicket = (a: Scored, b: Scored) => a.entry.n - b.entry.n || b.entry.i - a.entry.i;

const codeOf = (card: PulledCard) => encodeCard({ id: card.cardId, holo: card.isHolo, finish: card.finish, misprint: card.misprint });

interface Assignment {
  setId: string;
  setVersion: number;
  openedAt: number;
}

const sameAssignment = (e: StoredBest, a: Assignment) => e.s === a.setId && e.v === a.setVersion;

/**
 * Offers whole packs to `key`'s list and stores the result. One set assignment per nonce, picked as a
 * profile picks it (firstOpened) among the history's records, the stored winners and the candidates,
 * so conflicting records never award two packs. `advance` gets the weighed mark and the nonces whose
 * packs were taken, and returns the new mark. True when the list is stored; else it's held in memory,
 * shown as unsaved and retried by the next merge.
 */
export const mergeBestCards = (
  key: string,
  candidates: Iterable<BestCandidate>,
  advance: (weighed: number, taken: ReadonlySet<number>) => number,
): boolean => {
  if (!FULL_KEY.test(key)) return true;
  const read = readStore();
  const lists = [read?.store[key], pending.get(key)].filter((l): l is StoredList => !!l);
  // A list held in memory may be behind another tab's write, or ahead of it. Each is the exact top of
  // the tickets below its own mark, so their union is exact below the higher one.
  let weighed = lists.length ? Math.max(...lists.map((l) => l.w)) : 0;
  const existing = new Map<string, StoredBest>();
  for (const e of lists.flatMap((l) => l.b)) {
    const held = existing.get(instance(e));
    if (!held || (!held.c && e.c)) existing.set(instance(e), e);
  }

  const winners = new Map<number, Assignment>();
  const consider = (nonce: number, a: Assignment) => {
    const other = winners.get(nonce);
    if (!other || firstOpened(a, other) < 0) winners.set(nonce, a);
  };
  for (const e of historyForKey(key)) consider(e.nonce, e);
  for (const e of existing.values()) consider(e.n, { setId: e.s, setVersion: e.v, openedAt: e.t });
  const offered = [...candidates];
  for (const c of offered) consider(c.nonce, c);

  const next = new Map<string, StoredBest>();
  for (const e of existing.values()) {
    const winner = winners.get(e.n)!;
    // Lost its ticket to an earlier-opened assignment: what it pushed out may belong back, so reweigh.
    if (!sameAssignment(e, winner)) weighed = 0;
    else next.set(instance(e), { ...e, t: winner.openedAt });
  }
  const unscoredBefore = [...next.values()].filter((e) => !score(e).card).length;
  let ranked: Scored[] = [];
  const keepTop = () => {
    ranked = ranked.sort(byRank).slice(0, BEST_CARDS_CAP);
  };
  const taken = new Set<number>();
  for (const c of offered) {
    const winner = winners.get(c.nonce)!;
    if (taken.has(c.nonce) || c.setId !== winner.setId || c.setVersion !== winner.setVersion) continue;
    taken.add(c.nonce);
    const codes = new Map(c.cards.map((card) => [card.slot, codeOf(card)]));
    // The pack replaces what was held for its ticket. A held card that disagrees with it was a wrong
    // cache, and so may have pushed out what belongs back: reweigh.
    for (const [id, e] of next) {
      if (e.n !== c.nonce) continue;
      if (e.c && e.c !== codes.get(e.i)) weighed = 0;
      next.delete(id);
    }
    for (const card of c.cards) {
      const entry: StoredBest = { s: c.setId, v: c.setVersion, n: c.nonce, i: card.slot, c: codeOf(card), t: winner.openedAt };
      ranked.push({ entry, card, points: cardPoints(card.rarity, card.isHolo, card.finish, card.misprint) });
      if (ranked.length > 4 * BEST_CARDS_CAP) keepTop();
    }
  }
  const unscored: Scored[] = [];
  for (const e of next.values()) {
    const s = score(e);
    (s.card ? ranked : unscored).push(s);
  }
  unscored.sort(byTicket);
  // Unscored winners stay (any of them may be the strongest) and hold their places until rebuilt.
  if (unscored.length > BEST_CARDS_CAP || (unscored.length < unscoredBefore && existing.size >= BEST_CARDS_CAP)) weighed = 0;
  const kept = unscored.slice(0, BEST_CARDS_CAP);
  keepTop();
  const list: StoredList = {
    w: advance(weighed, taken),
    b: [...ranked.slice(0, BEST_CARDS_CAP - kept.length), ...kept].map((s) => s.entry),
  };

  if (!read) {
    // Unreadable or broken storage is left alone, as the pack history leaves it.
    pending.set(key, list);
    return false;
  }
  const store: Store = { ...read.store, [key]: list };
  if (!isBestCardsStore(store)) return false;
  const value = JSON.stringify(store);
  try {
    if (value !== read.raw) localStorage.setItem(STORAGE_KEYS.BEST_CARDS, value);
    pending.delete(key);
    return true;
  } catch {
    pending.set(key, list);
    return false;
  }
};

const fullKeyOf = (pack: OpenedPack) => (pack.publicKeyHex && FULL_KEY.test(pack.publicKeyHex) ? pack.publicKeyHex : null);

/** Offers a pack just opened. The weighed mark moves only past the next ticket in order, once taken. */
export const recordBestCards = (pack: OpenedPack): boolean => {
  const key = fullKeyOf(pack);
  const set = getSet(pack.setId, pack.setVersion);
  if (!key || !set) return true;
  const cards = toPulled(pack.cards.map((c) => ({ id: c.id, holo: c.isHolo, finish: c.finish, misprint: c.misprint })), set);
  if (!cards) return true;
  const candidate = { setId: pack.setId, setVersion: pack.setVersion, nonce: pack.nonce, openedAt: pack.openedAt, cards };
  return mergeBestCards(key, [candidate], (w, taken) => (w === pack.nonce && taken.has(w) ? w + 1 : w));
};

/** `key`'s list as last stored (or held in memory), for a key that has used `used` tickets. */
export const getBestCards = (publicKeyHex: string, used: number): BestCards => {
  const held = pending.get(publicKeyHex);
  const list = held ?? readStore()?.store[publicKeyHex];
  const scored = (list?.b ?? []).map(score);
  const ordered = [...scored.filter((s) => s.card).sort(byRank), ...scored.filter((s) => !s.card).sort(byTicket)];
  const cards = ordered.map(({ entry, card, points }): BestCard => ({
    publicKeyHex, setId: entry.s, setVersion: entry.v, nonce: entry.n, slot: entry.i, card, points,
  }));
  const complete = (list?.w ?? 0) >= used && cards.every((c) => c.card);
  return { cards, complete, unsaved: !!held };
};

/**
 * Rebuilds winners from their references with the engine (derivePack): the unscored ones, or with
 * `all` every one (a cached card is never trusted over its ticket). Each rebuilt pack is offered whole.
 * A pack that fails to rebuild keeps its winners as they are and counts in `failed`; call again to retry.
 */
export const rebuildBestCards = async (
  publicKeyHex: string,
  used: number,
  { all = false, ticketFn = computeTicket }: { all?: boolean; ticketFn?: TicketFn } = {},
): Promise<BestCards & { failed: number }> => {
  const packs = new Map<string, { entry: StoredBest; set: NonNullable<ReturnType<typeof getSet>> }>();
  const list = pending.get(publicKeyHex) ?? readStore()?.store[publicKeyHex];
  for (const entry of list?.b ?? []) {
    const set = getSet(entry.s, entry.v);
    if (set && (all || !score(entry).card)) packs.set(`${entry.n}`, { entry, set });
  }
  let failed = 0;
  const candidates: BestCandidate[] = [];
  for (const { entry, set } of packs.values()) {
    try {
      const cards = await derivePack(set, fromHex(publicKeyHex), entry.n, ticketFn);
      candidates.push({ setId: set.id, setVersion: set.version, nonce: entry.n, openedAt: entry.t, cards });
    } catch {
      failed++;
    }
  }
  if (candidates.length) mergeBestCards(publicKeyHex, candidates, (w) => w);
  return { ...getBestCards(publicKeyHex, used), failed };
};
