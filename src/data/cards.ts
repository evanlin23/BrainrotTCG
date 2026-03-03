// Use Vite's glob import to scan each rarity folder
const commonImages = import.meta.glob('../assets/cards/common/*.{png,jpg,jpeg,svg}', { eager: true }) as Record<string, { default: string }>;
const uncommonImages = import.meta.glob('../assets/cards/uncommon/*.{png,jpg,jpeg,svg}', { eager: true }) as Record<string, { default: string }>;
const rareImages = import.meta.glob('../assets/cards/rare/*.{png,jpg,jpeg,svg}', { eager: true }) as Record<string, { default: string }>;
const epicImages = import.meta.glob('../assets/cards/epic/*.{png,jpg,jpeg,svg}', { eager: true }) as Record<string, { default: string }>;
const legendaryImages = import.meta.glob('../assets/cards/legendary/*.{png,jpg,jpeg,svg}', { eager: true }) as Record<string, { default: string }>;
const brainrotImages = import.meta.glob('../assets/cards/brainrot/*.{png,jpg,jpeg,svg}', { eager: true }) as Record<string, { default: string }>;

export type RarityKey = 'COMMON' | 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY' | 'BRAINROT';

export interface RarityInfo {
  name: string;
  color: string;
  weight: number;
}

export const CARD_RARITIES: Record<RarityKey, RarityInfo> = {
  COMMON: { name: 'Common', color: '#aaaaaa', weight: 50 },
  UNCOMMON: { name: 'Uncommon', color: '#1eff00', weight: 25 },
  RARE: { name: 'Rare', color: '#0070dd', weight: 15 },
  EPIC: { name: 'Epic', color: '#a335ee', weight: 7 },
  LEGENDARY: { name: 'Legendary', color: '#ff8000', weight: 2.5 },
  BRAINROT: { name: 'Brainrot', color: 'rainbow', weight: 0.5 },
};

export interface Card {
  id: string;
  name: string;
  rarity: RarityKey;
  image: string;
}

// Helper to create cards from a folder's images
const createCardsFromFolder = (images: Record<string, { default: string }>, rarity: RarityKey): Card[] => {
  return Object.entries(images).map(([path, module]) => {
    const fileName = path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
    return {
      id: fileName,
      name: fileName,
      rarity,
      image: module.default,
    };
  });
};

// Combine all cards from each rarity folder
export const INITIAL_CARDS: Card[] = [
  ...createCardsFromFolder(commonImages, 'COMMON'),
  ...createCardsFromFolder(uncommonImages, 'UNCOMMON'),
  ...createCardsFromFolder(rareImages, 'RARE'),
  ...createCardsFromFolder(epicImages, 'EPIC'),
  ...createCardsFromFolder(legendaryImages, 'LEGENDARY'),
  ...createCardsFromFolder(brainrotImages, 'BRAINROT'),
];

// Get cards filtered by rarity
export const getCardsByRarity = (rarity: RarityKey): Card[] => {
  return INITIAL_CARDS.filter(card => card.rarity === rarity);
};

export const RARITY_VALUES: Record<RarityKey, number> = {
  COMMON: 1,
  UNCOMMON: 2,
  RARE: 4,
  EPIC: 7,
  LEGENDARY: 20,
  BRAINROT: 100,
};

export const getCardValue = (rarity: RarityKey, isHolo: boolean): number => {
  const baseValue = RARITY_VALUES[rarity] || 0;
  return isHolo ? baseValue * 20 : baseValue;
};
