import cardMetadata from './cards.json';

// Use Vite's glob import to scan the assets directory
const images = import.meta.glob('../assets/*.{png,jpg,jpeg,svg}', { eager: true });

export const CARD_RARITIES = {
  COMMON: { name: 'Common', color: '#aaaaaa', weight: 70 },
  RARE: { name: 'Rare', color: '#0070dd', weight: 20 },
  EPIC: { name: 'Epic', color: '#a335ee', weight: 8 },
  LEGENDARY: { name: 'Legendary', color: '#ff8000', weight: 2 },
};

// Transform the globbed images into a card list
export const INITIAL_CARDS = Object.entries(images).map(([path, module]) => {
  // Extract filename without extension (e.g., "../assets/skibidi.png" -> "skibidi")
  const fileName = path.split('/').pop().split('.').shift();

  // Get metadata or use defaults
  const meta = cardMetadata[fileName] || {
    name: fileName.charAt(0).toUpperCase() + fileName.slice(1),
    rarity: 'COMMON',
    description: 'A newly discovered brainrot entity.',
    hp: 1000,
    atk: 1000
  };

  return {
    id: fileName,
    ...meta,
    image: module.default || module,
  };
}).filter(card => card.id !== 'react'); // Exclude the default react icon if it exists

console.log('Detected Cards:', INITIAL_CARDS);
