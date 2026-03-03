import { INITIAL_CARDS, getCardValue, RarityKey } from '../data/cards';
import type { CollectionItem, Stats, CardsByRarity, RarityCount } from '../types';
import type { CardWithMeta } from '../components/Card';
import { MILESTONES } from '../constants';

type AchievementMap = Record<string, number>;

/**
 * Helper to add achievement if not already unlocked
 */
const addIfNew = (list: string[], id: string, achievements: AchievementMap): void => {
  if (!achievements[id]) {
    list.push(id);
  }
};

/**
 * Get the count of cards by rarity in the collection
 */
export const getCollectedByRarity = (collection: Record<string, CollectionItem>): RarityCount => {
  const result: RarityCount = {
    COMMON: [],
    UNCOMMON: [],
    RARE: [],
    EPIC: [],
    LEGENDARY: [],
    BRAINROT: [],
  };
  Object.values(collection).forEach(item => {
    result[item.card.rarity].push(item.card.id);
  });
  return result;
};

/**
 * Get total card counts by rarity from the card database
 */
export const getCardsByRarity = (): CardsByRarity => ({
  COMMON: INITIAL_CARDS.filter(c => c.rarity === 'COMMON').length,
  UNCOMMON: INITIAL_CARDS.filter(c => c.rarity === 'UNCOMMON').length,
  RARE: INITIAL_CARDS.filter(c => c.rarity === 'RARE').length,
  EPIC: INITIAL_CARDS.filter(c => c.rarity === 'EPIC').length,
  LEGENDARY: INITIAL_CARDS.filter(c => c.rarity === 'LEGENDARY').length,
  BRAINROT: INITIAL_CARDS.filter(c => c.rarity === 'BRAINROT').length,
});

/**
 * Calculate total holos owned across all collection items
 */
export const getTotalHolosOwned = (collection: Record<string, CollectionItem>): number => {
  return Object.values(collection).reduce((sum, item) => sum + (item.holoCount || 0), 0);
};

/**
 * Calculate max copies of any single card (normal + holo)
 */
export const getMaxCopiesOfCard = (collection: Record<string, CollectionItem>): number => {
  const copies = Object.values(collection).map(item =>
    (item.count ?? item.normalCount ?? 0) + (item.holoCount || 0)
  );
  return copies.length > 0 ? Math.max(...copies) : 0;
};

/**
 * Calculate total account value
 */
export const getAccountValue = (collection: Record<string, CollectionItem>): number => {
  return Object.values(collection).reduce((sum, item) => {
    const normalCount = item.count ?? item.normalCount ?? 0;
    const baseValue = getCardValue(item.card.rarity, false);
    const holoValue = getCardValue(item.card.rarity, true);
    return sum + (baseValue * normalCount) + (holoValue * (item.holoCount || 0));
  }, 0);
};

/**
 * Check pack milestone achievements
 */
export const checkPackMilestones = (
  packsOpened: number,
  achievements: AchievementMap
): string[] => {
  const newAchievements: string[] = [];

  if (packsOpened >= 1) addIfNew(newAchievements, 'first_pack', achievements);
  if (packsOpened >= 10) addIfNew(newAchievements, 'packs_10', achievements);
  if (packsOpened >= 41) addIfNew(newAchievements, 'packs_41', achievements);
  if (packsOpened >= 67) addIfNew(newAchievements, 'packs_67', achievements);
  if (packsOpened >= 100) addIfNew(newAchievements, 'packs_100', achievements);
  if (packsOpened >= 420) addIfNew(newAchievements, 'packs_420', achievements);
  if (packsOpened >= 1000) addIfNew(newAchievements, 'packs_1000', achievements);

  return newAchievements;
};

/**
 * Check collection-based achievements (can be checked retroactively)
 */
export const checkCollectionAchievements = (
  collection: Record<string, CollectionItem>,
  stats: Stats,
  achievements: AchievementMap
): string[] => {
  const newAchievements: string[] = [];

  // Collection size milestones
  const uniqueCards = Object.keys(collection).length;
  if (uniqueCards >= 5) addIfNew(newAchievements, 'collect_5', achievements);
  if (uniqueCards >= 10) addIfNew(newAchievements, 'collect_10', achievements);
  if (uniqueCards >= INITIAL_CARDS.length) {
    addIfNew(newAchievements, 'complete_collection', achievements);
  }

  // Holo collection milestones
  const holoCount = Object.keys(stats.holoCards || {}).length;
  if (holoCount >= 5) addIfNew(newAchievements, 'holo_collector', achievements);
  if (holoCount >= 10) addIfNew(newAchievements, 'holo_10', achievements);
  if (holoCount >= INITIAL_CARDS.length) {
    addIfNew(newAchievements, 'holo_complete', achievements);
  }

  // First holo
  if (holoCount > 0) addIfNew(newAchievements, 'first_holo', achievements);

  // Rarity discoveries based on collection
  const collectedRarities = new Set(Object.values(collection).map(item => item.card.rarity));
  if (collectedRarities.has('COMMON')) addIfNew(newAchievements, 'first_common', achievements);
  if (collectedRarities.has('UNCOMMON')) addIfNew(newAchievements, 'first_uncommon', achievements);
  if (collectedRarities.has('RARE')) addIfNew(newAchievements, 'first_rare', achievements);
  if (collectedRarities.has('EPIC')) addIfNew(newAchievements, 'first_epic', achievements);
  if (collectedRarities.has('LEGENDARY')) addIfNew(newAchievements, 'first_legendary', achievements);
  if (collectedRarities.has('BRAINROT')) addIfNew(newAchievements, 'first_brainrot', achievements);

  // Holo rarity achievements
  const holoCards = stats.holoCards || {};
  Object.keys(holoCards).forEach(cardId => {
    const card = INITIAL_CARDS.find(c => c.id === cardId);
    if (!card) return;

    if (card.rarity === 'COMMON') addIfNew(newAchievements, 'holo_common', achievements);
    if (card.rarity === 'UNCOMMON') addIfNew(newAchievements, 'holo_uncommon', achievements);
    if (card.rarity === 'RARE') addIfNew(newAchievements, 'holo_rare', achievements);
    if (card.rarity === 'EPIC') addIfNew(newAchievements, 'holo_epic', achievements);
    if (card.rarity === 'LEGENDARY') addIfNew(newAchievements, 'holo_legendary', achievements);
    if (card.rarity === 'BRAINROT') addIfNew(newAchievements, 'holo_brainrot', achievements);
  });

  // Rarity completion achievements
  const collectedByRarity = getCollectedByRarity(collection);
  const cardsByRarity = getCardsByRarity();

  const rarities: RarityKey[] = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'BRAINROT'];
  const rarityAchievementMap: Record<RarityKey, string> = {
    COMMON: 'all_commons',
    UNCOMMON: 'all_uncommons',
    RARE: 'all_rares',
    EPIC: 'all_epics',
    LEGENDARY: 'all_legendaries',
    BRAINROT: 'all_brainrots',
  };

  rarities.forEach(rarity => {
    if (collectedByRarity[rarity].length >= cardsByRarity[rarity] && cardsByRarity[rarity] > 0) {
      addIfNew(newAchievements, rarityAchievementMap[rarity], achievements);
    }
  });

  // Total holos owned milestones
  const totalHolosOwned = getTotalHolosOwned(collection);
  if (totalHolosOwned >= 25) addIfNew(newAchievements, 'total_holos_25', achievements);
  if (totalHolosOwned >= 100) addIfNew(newAchievements, 'total_holos_100', achievements);

  // Duplicate milestones
  const maxCopies = getMaxCopiesOfCard(collection);
  if (maxCopies >= 10) addIfNew(newAchievements, 'dupes_10', achievements);
  if (maxCopies >= 25) addIfNew(newAchievements, 'dupes_25', achievements);
  if (maxCopies >= 100) addIfNew(newAchievements, 'dupes_100', achievements);

  // Account value milestones
  const accountValue = getAccountValue(collection);
  if (accountValue >= 10000) addIfNew(newAchievements, 'value_10k', achievements);
  if (accountValue >= 100000) addIfNew(newAchievements, 'value_100k', achievements);
  if (accountValue >= 1000000) addIfNew(newAchievements, 'value_1m', achievements);

  return newAchievements;
};

/**
 * Check pack-specific achievements (can only be checked when opening a pack)
 */
export const checkPackAchievements = (
  newCards: CardWithMeta[],
  achievements: AchievementMap
): string[] => {
  const newAchievements: string[] = [];

  // Card counts in pack
  const cardCounts: Record<string, number> = {};
  newCards.forEach(c => {
    cardCounts[c.id] = (cardCounts[c.id] || 0) + 1;
  });
  const counts = Object.values(cardCounts);
  const maxCount = counts.length > 0 ? Math.max(...counts) : 0;

  // X of a kind achievements
  if (maxCount >= 2) addIfNew(newAchievements, 'two_of_kind', achievements);
  if (maxCount >= 3) addIfNew(newAchievements, 'three_of_kind', achievements);
  if (maxCount >= 4) addIfNew(newAchievements, 'four_of_kind', achievements);
  if (maxCount >= 5) addIfNew(newAchievements, 'five_of_kind', achievements);

  // Full house (3 + 2)
  const hasThree = counts.some(c => c >= 3);
  const hasTwo = counts.filter(c => c >= 2).length >= 2 || counts.some(c => c >= 5);
  if (hasThree && hasTwo) addIfNew(newAchievements, 'full_house', achievements);

  // Two pair
  const pairCount = counts.filter(c => c >= 2).length;
  if (pairCount >= 2) addIfNew(newAchievements, 'two_pair', achievements);

  // Rarity-based pack achievements
  const rarities = new Set(newCards.map(c => c.rarity));

  // All same rarity
  if (rarities.size === 1) addIfNew(newAchievements, 'all_same_rarity', achievements);

  // 5 different rarities
  if (rarities.size >= 5) addIfNew(newAchievements, 'five_rarities', achievements);

  // No commons in pack
  if (!rarities.has('COMMON') && newCards.length === 5) {
    addIfNew(newAchievements, 'no_commons', achievements);
  }

  // All commons in pack
  if (newCards.every(c => c.rarity === 'COMMON')) {
    addIfNew(newAchievements, 'all_commons_pack', achievements);
  }

  // Holo pack achievements
  const holosInPack = newCards.filter(c => c.isHolo).length;
  if (holosInPack >= 2) addIfNew(newAchievements, 'double_holo', achievements);
  if (holosInPack >= 3) addIfNew(newAchievements, 'triple_holo', achievements);
  if (holosInPack >= 4) addIfNew(newAchievements, 'quad_holo', achievements);
  if (holosInPack >= 5) addIfNew(newAchievements, 'all_holos', achievements);

  // Holo + rarity combos in this pack
  const holoRarities: RarityKey[] = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'BRAINROT'];
  const holoRarityAchievementMap: Record<RarityKey, string> = {
    COMMON: 'holo_common',
    UNCOMMON: 'holo_uncommon',
    RARE: 'holo_rare',
    EPIC: 'holo_epic',
    LEGENDARY: 'holo_legendary',
    BRAINROT: 'holo_brainrot',
  };

  holoRarities.forEach(rarity => {
    if (newCards.some(c => c.isHolo && c.rarity === rarity)) {
      addIfNew(newAchievements, holoRarityAchievementMap[rarity], achievements);
    }
  });

  // Lucky day (2+ legendary or brainrot)
  const luckyCount = newCards.filter(c => c.rarity === 'LEGENDARY' || c.rarity === 'BRAINROT').length;
  if (luckyCount >= 2) addIfNew(newAchievements, 'lucky_day', achievements);

  return newAchievements;
};
