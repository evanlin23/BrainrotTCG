/** GitHub repo that hosts the game and its Hall of Fame issues. */
export const REPO = 'evanlin23/BrainrotTCG';

// Storage keys
export const STORAGE_KEYS = {
  COLLECTION: 'brainrot-found-collection-v1',
  /**
   * Exact unreadable collection payloads kept before a filtered collection replaces them: the first,
   * the newest under `later`, a `dropped` count of later ones let go to stay in budget, and
   * `kind: 'unparseable-archive'` when the first is an older archive that couldn't be read.
   */
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
  /** Each player's best cards, as rebuildable ticket/slot references (see game/bestCards.ts). */
  BEST_CARDS: 'brainrot-best-cards-v1',
  /** The list of owed packs earlier builds kept: load takes this player's packs off it, and nothing new goes on it (see game/pulls.ts). */
  PENDING_PACKS: 'brainrot-pending-packs-v2',
  /**
   * Each pack whose ticket is spent but which hasn't reached the collection yet, under its own key
   * `<prefix><player key>:<nonce>`, so a tab writing or clearing one pack never rewrites another (see game/pulls.ts).
   */
  PENDING_PACK_PREFIX: 'brainrot-pending-pack-v3:',
  /** The one-pack entry older builds keep instead; read here, and written only to put back the pack it held (see game/pulls.ts). */
  PENDING_PACK: 'brainrot-pending-pack-v1',
  /**
   * Which packs the stored collection holds, as `{ k: player key, n: [[first, last], ...] }` nonce ranges,
   * written just before each collection write (see game/progressGuard.ts).
   */
  STORED_PACKS: 'brainrot-stored-packs-v1',
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
