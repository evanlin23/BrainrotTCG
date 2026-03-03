// Storage keys
export const STORAGE_KEYS = {
  COLLECTION: 'brainrot-found-collection-v1',
  ACHIEVEMENTS: 'brainrot-achievements-v1',
  STATS: 'brainrot-stats-v1',
  HALL_OF_FAME: 'brainrot-hall-of-fame-v1',
} as const;

// Pack configuration
export const PACK_CONFIG = {
  SIZE: 5,
  HOLO_CHANCE: 0.05,
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

// Rarity thresholds for pack generation (cumulative percentages)
export const RARITY_THRESHOLDS = {
  BRAINROT: 0.5,
  LEGENDARY: 3,
  EPIC: 10,
  RARE: 25,
  UNCOMMON: 50,
  // COMMON is the fallback (50-100%)
} as const;
