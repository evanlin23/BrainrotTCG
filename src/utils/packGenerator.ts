import type { Card as CardType, RarityKey } from '../data/cards';
import type { CardWithMeta } from '../components/Card';
import { RARITY_THRESHOLDS, PACK_CONFIG } from '../constants';

/**
 * Generate a random card based on rarity thresholds
 */
const getRandomCard = (cards: CardType[]): CardType => {
  const random = Math.random() * 100;
  let rarity: RarityKey;

  if (random < RARITY_THRESHOLDS.BRAINROT) {
    rarity = 'BRAINROT';
  } else if (random < RARITY_THRESHOLDS.LEGENDARY) {
    rarity = 'LEGENDARY';
  } else if (random < RARITY_THRESHOLDS.EPIC) {
    rarity = 'EPIC';
  } else if (random < RARITY_THRESHOLDS.RARE) {
    rarity = 'RARE';
  } else if (random < RARITY_THRESHOLDS.UNCOMMON) {
    rarity = 'UNCOMMON';
  } else {
    rarity = 'COMMON';
  }

  let filtered = cards.filter(c => c.rarity === rarity);
  if (!filtered.length) filtered = cards;

  return filtered[Math.floor(Math.random() * filtered.length)];
};

/**
 * Generate a pack of random cards
 */
export const generatePack = (cards: CardType[], packSize: number = PACK_CONFIG.SIZE): CardWithMeta[] => {
  return Array.from({ length: packSize }, () => {
    const card = getRandomCard(cards);
    const isHolo = Math.random() < PACK_CONFIG.HOLO_CHANCE;

    return {
      ...card,
      uniqueId: Math.random(),
      isRevealed: false,
      isHolo,
    };
  });
};
