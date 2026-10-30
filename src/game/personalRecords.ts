/**
 * Personal records derived from local pack history (#1287, slice A: the summary's NEW BEST line).
 *
 * Strava's rule: a record needs a prior value to beat, so a player's first comparable pack sets the
 * best silently and only a later pack that strictly beats it is a NEW BEST (a tie isn't). Derived from
 * the history on each read and never stored, so no save changes shape. Display only: no odds, proofs
 * or scoring change.
 */
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

/**
 * Whether `score` (the pack just opened with this ticket) beats the best this player had before it,
 * across every set: their packs on earlier tickets, one record per ticket (the one a profile admits,
 * firstOpened), counting only packs with a known hand and score (a ticket stand-in has neither yet).
 * Null on the first comparable pack, on a tie or below, and for a pack with no key. Null too when the
 * history admits another set's record of this same ticket (two tabs spent it, and that one opened
 * first): a profile counts that record, not this pack, so this pack can't be the player's best.
 */
export const newBestPack = (history: readonly HistoryEntry[], pack: RecordPack, score: number): NewBest | null => {
  if (!pack.publicKeyHex || !Number.isFinite(score)) return null;
  const admitted = new Map<number, HistoryEntry>();
  for (const e of history.filter(isKeysEntry(pack.publicKeyHex))) {
    if (e.nonce > pack.nonce) continue;
    const other = admitted.get(e.nonce);
    if (!other || firstOpened(e, other) < 0) admitted.set(e.nonce, e);
  }
  // This ticket's admitted record (it is normally this pack's own, recorded as it opened).
  const own = admitted.get(pack.nonce);
  if (own && (own.setId !== pack.setId || own.setVersion !== pack.setVersion)) return null;
  admitted.delete(pack.nonce);
  let previous: number | null = null;
  for (const e of admitted.values()) {
    if (e.hand === '' || !Number.isFinite(e.score)) continue;
    if (previous === null || e.score > previous) previous = e.score;
  }
  return previous !== null && score > previous ? { score, previous } : null;
};

/** "+117%": how far a new best is above the previous one, or null when that rounds below 1% or has no ratio. */
export const newBestGain = ({ score, previous }: NewBest): string | null => {
  if (previous <= 0) return null;
  const percent = Math.round(((score - previous) / previous) * 100);
  return percent >= 1 ? `+${percent.toLocaleString()}%` : null;
};
