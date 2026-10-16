import { STORAGE_KEYS } from '../constants';

/**
 * The progress a tab reads once when it loads and later stores whole: the collection, stats, Hall
 * of Fame and achievements. Settings stay last-writer-wins, and the history and the pending shelf
 * are re-read before every write (game/history.ts, game/pulls.ts), so they need no guard.
 */
export const GUARDED_PROGRESS: readonly string[] = [
  STORAGE_KEYS.COLLECTION, STORAGE_KEYS.STATS, STORAGE_KEYS.HALL_OF_FAME, STORAGE_KEYS.ACHIEVEMENTS,
];

/** What storage holds under a key, as stored; null when it holds nothing or can't be read. */
const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

export interface ProgressGuard {
  /** True while storage still holds the progress this tab last read or stored (another tab wrote none since). */
  current(): boolean;
  /**
   * After this tab's writes (checked current just before, in the same task): what storage holds now is
   * this tab's. A write that failed (out of space) left its key as it was, so that key's stays as it was.
   */
  noted(): void;
  /**
   * Just before this tab stores a collection holding `nonces` (packs opened as `player`): records that
   * the stored collection will hold them, beside the packs the collection this tab last read or stored
   * holds. False when storage refuses.
   */
  storing(player: string, nonces: readonly number[]): boolean;
  /** The collection write after `storing` failed: storage holds the record as this tab last read it. */
  unstored(): void;
  /**
   * Of `nonces` (packs this tab stored as `player`), the ones the stored collection no longer holds:
   * another tab stored its own collection over them. None when the record is missing or another player's.
   */
  dropped(player: string, nonces: readonly number[]): number[];
}

/** Which packs the stored collection holds (STORAGE_KEYS.STORED_PACKS): a player key and nonce ranges. */
interface StoredPacks {
  k: string;
  n: [number, number][];
}

const readStoredPacks = (raw: string | null): StoredPacks | null => {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (typeof value !== 'object' || value === null) return null;
    const { k, n } = value as Partial<StoredPacks>;
    if (typeof k !== 'string' || !Array.isArray(n)) return null;
    return { k, n: n.filter((r): r is [number, number] => Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1])) };
  } catch {
    return null;
  }
};

const holds = (ranges: readonly [number, number][], nonce: number) => ranges.some(([lo, hi]) => lo <= nonce && nonce <= hi);

/** Ranges holding every nonce in `ranges` and `nonces`, merged where they touch. */
const withNonces = (ranges: readonly [number, number][], nonces: readonly number[]): [number, number][] => {
  const all: [number, number][] = [...ranges, ...nonces.map((n): [number, number] => [n, n])].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [lo, hi] of all) {
    const last = merged[merged.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged;
};

/**
 * Remembers the progress as stored when a tab loads. Another tab of the same player (no import or
 * switch, so the save stamp is unchanged: see game/player.ts) can store progress meanwhile; a tab
 * that then stored what it holds would drop that tab's packs, cards and unlocks. Checked before every
 * write, so the tab refuses instead and the player reloads to continue with the newer progress.
 * Storage has no lock across tabs: two tabs writing in the same instant can both pass the check, and
 * the later write replaces the earlier (the history keeps that pack). The tab that wrote first then
 * hears the other's write (watchProgress) and stops.
 */
export const guardProgress = (): ProgressGuard => {
  const seen = new Map(GUARDED_PROGRESS.map((key) => [key, stored(key)]));
  // Which packs the collection in `seen` holds, as stored with it (not guarded: only collection writes
  // change it, and they change the collection too).
  let seenPacks = stored(STORAGE_KEYS.STORED_PACKS);
  return {
    current: () => GUARDED_PROGRESS.every((key) => stored(key) === seen.get(key)),
    noted: () => {
      for (const key of GUARDED_PROGRESS) seen.set(key, stored(key));
      seenPacks = stored(STORAGE_KEYS.STORED_PACKS);
    },
    // From what this tab read, not what storage holds now: when two tabs pass the check at once, the
    // later collection replaces the earlier, and so does its record, so the earlier tab's packs leave it.
    storing: (player, nonces) => {
      const from = readStoredPacks(seenPacks);
      try {
        localStorage.setItem(STORAGE_KEYS.STORED_PACKS, JSON.stringify({ k: player, n: withNonces(from?.k === player ? from.n : [], nonces) }));
        return true;
      } catch {
        return false;
      }
    },
    unstored: () => {
      try {
        if (seenPacks === null) localStorage.removeItem(STORAGE_KEYS.STORED_PACKS);
        else localStorage.setItem(STORAGE_KEYS.STORED_PACKS, seenPacks);
      } catch {
        // It stays claiming packs the collection doesn't hold: a tab that went stale keeps those off the shelf.
      }
    },
    dropped: (player, nonces) => {
      const now = readStoredPacks(stored(STORAGE_KEYS.STORED_PACKS));
      if (!now || now.k !== player) return [];
      return nonces.filter((nonce) => !holds(now.n, nonce));
    },
  };
};

/** Calls `onChange` when another tab writes guarded progress (or clears storage). Returns the unsubscribe. */
export const watchProgress = (onChange: () => void): (() => void) => {
  const listener = (event: StorageEvent) => {
    if (event.key === null || GUARDED_PROGRESS.includes(event.key)) onChange();
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
};
