/** GitHub repo that hosts the game and its Hall of Fame issues. */
export const REPO = 'evanlin23/BrainrotTCG';

// Storage keys
export const STORAGE_KEYS = {
  COLLECTION: 'brainrot-found-collection-v1',
  /** Exact unreadable collection payload kept before a filtered collection replaces it. */
  COLLECTION_RECOVERY: 'brainrot-collection-recovery-v1',
  /** Fingerprint of the archive whose kept-aside note this viewer hid (not part of a save). */
  COLLECTION_RECOVERY_SEEN: 'brainrot-collection-recovery-seen-v1',
  ACHIEVEMENTS: 'brainrot-achievements-v1',
  STATS: 'brainrot-stats-v1',
  HALL_OF_FAME: 'brainrot-hall-of-fame-v1',
  SETTINGS: 'brainrot-settings-v1',
  SELECTED_SET: 'brainrot-selected-set-v1',
  /** Old notable-pulls log; migrated into HISTORY on load. */
  PULLS: 'brainrot-pulls-v1',
  HISTORY: 'brainrot-history-v1',
  /** Packs whose tickets are spent but which haven't reached the collection yet, as a list (see game/pulls.ts). */
  PENDING_PACKS: 'brainrot-pending-packs-v2',
  /** The one-pack entry older builds keep instead; read and cleared here, never written (see game/pulls.ts). */
  PENDING_PACK: 'brainrot-pending-pack-v1',
} as const;

// Achievement milestone thresholds
export const MILESTONES = {
  PACKS: [1, 10, 41, 67, 100, 420, 1000],
  COLLECTION: [5, 10],
  HOLO_COLLECTION: [5, 10],
  TOTAL_HOLOS: [25, 100],
  DUPLICATES: [10, 25, 100],
  ACCOUNT_VALUE: [10000, 100000, 1000000],
  HOLOS_IN_PACK: [2, 3, 4, 5],
} as const;
