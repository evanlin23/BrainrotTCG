// Use Vite's glob import to scan each rarity folder
const commonImages = import.meta.glob('../assets/cards/common/*.{png,jpg,jpeg,svg}', { eager: true });
const uncommonImages = import.meta.glob('../assets/cards/uncommon/*.{png,jpg,jpeg,svg}', { eager: true });
const rareImages = import.meta.glob('../assets/cards/rare/*.{png,jpg,jpeg,svg}', { eager: true });
const epicImages = import.meta.glob('../assets/cards/epic/*.{png,jpg,jpeg,svg}', { eager: true });
const legendaryImages = import.meta.glob('../assets/cards/legendary/*.{png,jpg,jpeg,svg}', { eager: true });
const brainrotImages = import.meta.glob('../assets/cards/brainrot/*.{png,jpg,jpeg,svg}', { eager: true });

export const CARD_RARITIES = {
  COMMON: { name: 'Common', color: '#aaaaaa', weight: 50 },
  UNCOMMON: { name: 'Uncommon', color: '#1eff00', weight: 25 },
  RARE: { name: 'Rare', color: '#0070dd', weight: 15 },
  EPIC: { name: 'Epic', color: '#a335ee', weight: 7 },
  LEGENDARY: { name: 'Legendary', color: '#ff8000', weight: 2.5 },
  BRAINROT: { name: 'Brainrot', color: 'rainbow', weight: 0.5 },
};

// Helper to create cards from a folder's images
const createCardsFromFolder = (images, rarity) => {
  return Object.entries(images).map(([path, module]) => {
    const fileName = path.split('/').pop().replace(/\.[^.]+$/, '');
    return {
      id: fileName,
      name: fileName,
      rarity,
      image: module.default || module,
    };
  });
};

// Combine all cards from each rarity folder
export const INITIAL_CARDS = [
  ...createCardsFromFolder(commonImages, 'COMMON'),
  ...createCardsFromFolder(uncommonImages, 'UNCOMMON'),
  ...createCardsFromFolder(rareImages, 'RARE'),
  ...createCardsFromFolder(epicImages, 'EPIC'),
  ...createCardsFromFolder(legendaryImages, 'LEGENDARY'),
  ...createCardsFromFolder(brainrotImages, 'BRAINROT'),
];

// Get cards filtered by rarity
export const getCardsByRarity = (rarity) => {
  return INITIAL_CARDS.filter(card => card.rarity === rarity);
};

