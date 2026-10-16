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
}

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
  return {
    current: () => GUARDED_PROGRESS.every((key) => stored(key) === seen.get(key)),
    noted: () => {
      for (const key of GUARDED_PROGRESS) seen.set(key, stored(key));
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
