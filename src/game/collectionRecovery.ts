import { STORAGE_KEYS } from '../constants';
import { collectionNeedsRecovery } from '../utils/migrations';

export type CollectionSaveResult = 'saved' | 'recovered' | 'blocked';

/**
 * Hydration may hide unreadable entries. Never let the next pack silently erase
 * them: keep their exact original bytes in the private export first. One archive
 * is deliberately bounded; a different damaged payload needs manual recovery.
 */
export const persistCollection = (next: unknown): CollectionSaveResult => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.COLLECTION);
    let needsRecovery = false;
    if (raw !== null) {
      try {
        needsRecovery = collectionNeedsRecovery(JSON.parse(raw));
      } catch {
        needsRecovery = true;
      }
    }
    if (needsRecovery) {
      const archive = JSON.stringify({ raw, player: localStorage.getItem('brainrot-player-v1') });
      const previous = localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY);
      if (previous !== null) {
        // The original identity snapshot stays with the bytes; later ticket
        // counters/names must not rewrite it, nor may a different archive vanish.
        try {
          if (JSON.parse(previous).raw !== raw) return 'blocked';
        } catch { return 'blocked'; }
      }
      if (previous === null) localStorage.setItem(STORAGE_KEYS.COLLECTION_RECOVERY, archive);
    }
    localStorage.setItem(STORAGE_KEYS.COLLECTION, JSON.stringify(next));
    return needsRecovery ? 'recovered' : 'saved';
  } catch {
    // Reads, archive writes and collection writes can all be denied independently.
    return 'blocked';
  }
};
