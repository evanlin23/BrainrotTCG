import type { Card } from '../data/cards';
import type { CardWithMeta } from '../components/Card';

export interface CollectionItem {
  card: Card;
  normalCount: number;
  holoCount: number;
  count?: number; // legacy field
}

export interface Stats {
  packsOpened: number;
  holoCards: Record<string, boolean>;
  highestPackValue?: number; // legacy
  highestPackFlexValue?: number;
  highestPackBaseValue?: number;
  highestPackMultiplier?: number;
  highestPackHandName?: string;
  highestPackCards?: CardWithMeta[];
}

export interface HallOfFameData {
  first4OfAKind?: {
    achieved: boolean;
    date: number;
    cardId: string;
  };
  firstFullHouse?: {
    achieved: boolean;
    date: number;
    cards: Record<string, number>;
  };
}

export type Rarity = 'COMMON' | 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY' | 'BRAINROT';

export interface RarityCount {
  COMMON: string[];
  UNCOMMON: string[];
  RARE: string[];
  EPIC: string[];
  LEGENDARY: string[];
  BRAINROT: string[];
}

export interface CardsByRarity {
  COMMON: number;
  UNCOMMON: number;
  RARE: number;
  EPIC: number;
  LEGENDARY: number;
  BRAINROT: number;
}
