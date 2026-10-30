/**
 * Personal records derived from local pack history (#1287): the summary's record line and the Profile
 * record book.
 *
 * Strava's rule: a record needs a prior value to beat, so a player's first comparable pack sets the
 * best silently and only a later pack that strictly beats it is a NEW BEST (a tie isn't). Derived from
 * the history on each read and never stored, so no save changes shape. Display only: no odds, proofs
 * or scoring change.
 */
import { newestFirst, packTiers, readablePack } from './droughtCounters';
import { firstOpened, isKeysEntry, type HistoryEntry } from './history';

export interface NewBest {
  /** This pack's score. */
  score: number;
  /** The player's best before it, which it strictly beats. */
  previous: number;
}

/** A pack whose ticket this history records. */
export interface RecordPack {
  setId: string;
  setVersion: number;
  nonce: number;
  /** The key that opened it: only that player's packs are compared, never another identity's. */
  publicKeyHex?: string;
}

/** A pack with a known hand and score: a ticket stand-in (recordTicket) has neither yet. */
const isComparable = (e: HistoryEntry): boolean => e.hand !== '' && Number.isFinite(e.score);

/**
 * This key's packs in ticket order, one record per ticket: the one a profile admits (firstOpened) when
 * two tabs or a backup recorded more than one. Only records whose key prefix is exactly this key's, so
 * another identity's packs never count.
 */
export const admittedPacks = (history: readonly HistoryEntry[], publicKeyHex: string): HistoryEntry[] => {
  const admitted = new Map<number, HistoryEntry>();
  for (const e of history.filter(isKeysEntry(publicKeyHex))) {
    const other = admitted.get(e.nonce);
    if (!other || firstOpened(e, other) < 0) admitted.set(e.nonce, e);
  }
  return [...admitted.values()].sort((a, b) => a.nonce - b.nonce);
};

/**
 * The player's comparable packs on tickets before this pack's. Null for a pack with no key, and when the
 * history admits another set's record of this same ticket (two tabs spent it, and that one opened first):
 * a profile counts that record, not this pack, so this pack can't hold a record.
 */
const packsBefore = (history: readonly HistoryEntry[], pack: RecordPack): HistoryEntry[] | null => {
  if (!pack.publicKeyHex) return null;
  const admitted = admittedPacks(history, pack.publicKeyHex);
  // This ticket's admitted record (it is normally this pack's own, recorded as it opened).
  const own = admitted.find((e) => e.nonce === pack.nonce);
  if (own && (own.setId !== pack.setId || own.setVersion !== pack.setVersion)) return null;
  return admitted.filter((e) => e.nonce < pack.nonce && isComparable(e));
};

const bestScore = (packs: readonly HistoryEntry[]): number | null =>
  packs.reduce<number | null>((best, e) => (best === null || e.score > best ? e.score : best), null);

/**
 * Whether `score` (the pack just opened with this ticket) beats the best this player had before it,
 * across every set: their packs on earlier tickets, one record per ticket (the one a profile admits,
 * firstOpened), counting only packs with a known hand and score (a ticket stand-in has neither yet).
 * Null on the first comparable pack, on a tie or below, and for a pack with no key. Null too when the
 * history admits another set's record of this same ticket (two tabs spent it, and that one opened
 * first): a profile counts that record, not this pack, so this pack can't be the player's best.
 */
export const newBestPack = (history: readonly HistoryEntry[], pack: RecordPack, score: number): NewBest | null => {
  const record = packRecord(history, pack, score);
  return record?.kind === 'best' ? { score: record.score, previous: record.previous } : null;
};

/**
 * What the pack just opened set, for the summary (Spec 2 on #757), by the same rules as newBestPack:
 * - `best`: it strictly beat the player's best before it, across every set (a solid medal);
 * - `set-best`: it didn't, but strictly beat their best in its own set (any version), which needs an
 *   earlier pack in that set (an outlined medal);
 * - `top`: it is their #2 or #3 pack so far, counting this one (an earlier pack with an equal score
 *   ranks above it: ties keep the earlier record). Strava's rule again: it needs at least 2 earlier
 *   packs, and it must beat at least one of them, so a player's worst pack is never "#2".
 * Null otherwise, and on the first comparable pack.
 */
export type PackRecord =
  | ({ kind: 'best' } & NewBest)
  | ({ kind: 'set-best'; setId: string } & NewBest)
  | { kind: 'top'; rank: 2 | 3 };

export const packRecord = (history: readonly HistoryEntry[], pack: RecordPack, score: number): PackRecord | null => {
  if (!Number.isFinite(score)) return null;
  const before = packsBefore(history, pack);
  const previous = before && bestScore(before);
  if (!before || previous === null) return null;
  if (score > previous) return { kind: 'best', score, previous };
  const inSet = bestScore(before.filter((e) => e.setId === pack.setId));
  if (inSet !== null && score > inSet) return { kind: 'set-best', setId: pack.setId, score, previous: inSet };
  const rank = 1 + before.filter((e) => e.score >= score).length;
  if (before.length < 2 || rank > before.length) return null;
  return rank === 2 || rank === 3 ? { kind: 'top', rank } : null;
};

/** The medal a pack in Profile history keeps: what it set when it opened (packRecord's best or set-best). */
export type PackMedal = 'best' | 'set-best';

/**
 * Every pack of this player's that set a record when it opened, against the packs on earlier tickets
 * (the moment is transient; the medal stays on the pack's row, Spec 2). Keyed by the history entry
 * itself, so only the record a profile admits for a ticket gets one.
 */
export const packMedals = (history: readonly HistoryEntry[], publicKeyHex: string): Map<HistoryEntry, PackMedal> => {
  const medals = new Map<HistoryEntry, PackMedal>();
  let best: number | null = null;
  const bySet = new Map<string, number>();
  for (const e of admittedPacks(history, publicKeyHex)) {
    if (!isComparable(e)) continue;
    const setBest = bySet.get(e.setId);
    if (best !== null && e.score > best) medals.set(e, 'best');
    else if (setBest !== undefined && e.score > setBest) medals.set(e, 'set-best');
    if (best === null || e.score > best) best = e.score;
    if (setBest === undefined || e.score > setBest) bySet.set(e.setId, e.score);
  }
  return medals;
};

/**
 * Where a record stands. Strava's rule: the first value only sets the bar, and a record is set by a later
 * one that strictly beats the best before it (a tie keeps the earlier one).
 */
export interface Standing {
  /** The record once one is set; before that, the first value, the one to beat. */
  value: number;
  /** What the record beat. Null while none is set (nothing has beaten the first value yet). */
  previous: number | null;
  /** When the pack (or day, by its first pack) holding `value` was opened. */
  at: number;
}

/** A Standing over values in the order they happened. Null when there are none. */
const standing = (values: Iterable<{ value: number; at: number }>): Standing | null => {
  let current: Standing | null = null;
  for (const { value, at } of values) {
    if (current === null) current = { value, previous: null, at };
    else if (value > current.value) current = { value, previous: current.value, at };
  }
  return current;
};

export interface SetStanding extends Standing {
  setId: string;
}

/** The record book (Spec 2 on #757): the player's personal records, derived from their history on each read. */
export interface RecordBook {
  /** Best Brainrot Score in each set the player has a comparable pack in, in ticket order of each set's first one. */
  bestPackBySet: SetStanding[];
  /** Most holo cards in one pack, over packs whose cards this device can read. */
  mostHolos: Standing | null;
  /** Most packs opened on one calendar day, in this device's time zone. */
  mostPacksInADay: Standing | null;
  /** The longest Brainrot drought a Brainrot ended: packs in a row without one, before the pack that had one. */
  longestDroughtBroken: Standing | null;
}

/** A calendar day in this device's time zone, or null for a time that isn't one. */
const dayOf = (t: number): string | null => {
  if (!Number.isFinite(t) || t <= 0) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/**
 * The player's record book, from their own key's packs only, one record per ticket (admittedPacks).
 * - Best pack per set counts packs with a known hand and score (stand-ins are skipped), in ticket order.
 * - Most holos reads cards as the drought counter does (droughtCounters' readablePack), in ticket order:
 *   a stand-in counts once its cards are on this device, and a pack whose cards can't be read is skipped.
 * - Most packs in a day counts those packs by the day they opened (openedAt), in this device's time zone.
 * - Longest drought broken reads packs as the profile's drought counter does (droughtCounters: its
 *   order, and a pack counts once its cards are on this device). A drought counts only when every pack
 *   in it could be read: one with unreadable cards (or a card id its set doesn't list) leaves its length
 *   unknown, so the drought it is in isn't counted. The first drought runs from the first pack recorded.
 */
export const recordBook = (history: readonly HistoryEntry[], publicKeyHex: string): RecordBook => {
  const admitted = admittedPacks(history, publicKeyHex);
  const packs = admitted.filter(isComparable);

  const sets = new Map<string, HistoryEntry[]>();
  for (const e of packs) sets.set(e.setId, [...(sets.get(e.setId) ?? []), e]);
  const bestPackBySet = [...sets].map(([setId, inSet]) => ({
    setId,
    ...standing(inSet.map((e) => ({ value: e.score, at: e.openedAt })))!,
  }));

  const mostHolos = standing(
    admitted.flatMap((e) => {
      const pack = readablePack(e);
      return pack ? [{ value: pack.cards.filter((c) => c.holo).length, at: e.openedAt }] : [];
    }),
  );

  const days = new Map<string, { value: number; at: number }>();
  for (const e of packs) {
    const day = dayOf(e.openedAt);
    if (day === null) continue;
    const seen = days.get(day);
    days.set(day, { value: (seen?.value ?? 0) + 1, at: Math.min(seen?.at ?? e.openedAt, e.openedAt) });
  }
  const mostPacksInADay = standing([...days.values()].sort((a, b) => a.at - b.at));

  const droughts: { value: number; at: number }[] = [];
  let run = 0;
  let known = true;
  for (const e of [...admitted].sort(newestFirst).reverse()) {
    const brainrot = packTiers(e)?.brainrot ?? null;
    if (brainrot === null) known = false;
    else if (brainrot) {
      if (known) droughts.push({ value: run, at: e.openedAt });
      run = 0;
      known = true;
    } else run++;
  }
  const longestDroughtBroken = standing(droughts);

  return { bestPackBySet, mostHolos, mostPacksInADay, longestDroughtBroken };
};

/** "+117%": how far a new best is above the previous one, or null when that rounds below 1% or has no ratio. */
export const newBestGain = ({ score, previous }: NewBest): string | null => {
  if (previous <= 0) return null;
  const percent = Math.round(((score - previous) / previous) * 100);
  return percent >= 1 ? `+${percent.toLocaleString()}%` : null;
};
