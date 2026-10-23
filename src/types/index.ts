import type { Finish } from '../engine';
import type { Card } from '../data/cards';
import type { CardWithMeta } from './card';
import type { PullRef } from '../game/pulls';

export interface AchievementData {
  unlockedAt: number;
  pack?: CardWithMeta[];
  /** The pack's ticket, so it can be shared. Achievements unlocked before this was kept don't have it. */
  ref?: PullRef;
}

export interface CollectionItem {
  card: Card;
  normalCount: number;
  holoCount: number;
  count?: number; // legacy field
  /** Copies with each finish, and misprints (sets with modifiers). */
  finishes?: Partial<Record<Finish, number>>;
  misprints?: number;
  /** Points those modified copies earned beyond their plain or holo value, so the collection's value stays exact. */
  modifierPoints?: number;
}

export interface Stats {
  packsOpened: number;
  holoCards: Record<string, boolean>;
  highestPackValue?: number; // legacy (pre-poker-hands); migration v3 removes it once the pack is rescored
  /** Best pack's Brainrot Score (field name predates the rename). */
  highestPackFlexValue?: number;
  /** Best pack's card points. */
  highestPackBaseValue?: number;
  highestPackMultiplier?: number;
  highestPackHandName?: string;
  highestPackCards?: CardWithMeta[];
  /** Ticket reference of the best pack, so it can be shared as a verifiable proof. */
  highestPackRef?: { setId: string; setVersion: number; nonce: number; publicKeyHex?: string };
  /** The best pack predates verifiable pulls and can't be proven. */
  highestPackLegacy?: boolean;
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

export interface Settings {
  /** Sound effects volume slider (cards, the pack, voices), 0 (off) to 1 (utils/settings.ts). */
  effectsVolume: number;
  particlesEnabled: boolean;
  /** Hold good pulls for three seconds; defaults to on for older saves. Effects still play when off. */
  pauseBigPulls?: boolean;
  /** Chosen level rewards (game/progression.ts); a locked choice falls back to the first. */
  cardBack?: string;
  packFoil?: string;
  /** Show draft sets (placeholder art) in the set picker. */
  showDraftSets?: boolean;
  /** Show the tabs and set picker before a first pack is saved (#222); a new player's default is to hide them. */
  showAllPages?: boolean;
}
