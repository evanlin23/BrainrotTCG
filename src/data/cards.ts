/**
 * UI-facing card data: set definitions from the registry + built image URLs.
 * Card definitions live in `src/content/sets/<set>/set.json`.
 */
import { ALL_SET_VERSIONS, getCardDefinition, isOpenable, SETS } from '../content/sets';
import { cardImageUrl } from '../content/art';
import { cardPoints as engineCardPoints, scorePack, type CardDefinition, type Finish, type PackScore, type Rarity } from '../engine';

export type RarityKey = Rarity;

export interface RarityInfo {
  name: string;
  color: string;
  /** Printed next to the name, like a TCG rarity mark, so rarity never relies on colour alone. */
  symbol: string;
}

export const CARD_RARITIES: Record<RarityKey, RarityInfo> = {
  COMMON: { name: 'Common', color: '#aaaaaa', symbol: '\u25CF' },
  UNCOMMON: { name: 'Uncommon', color: '#1eff00', symbol: '\u25C6' },
  RARE: { name: 'Rare', color: '#0070dd', symbol: '\u2605' },
  EPIC: { name: 'Epic', color: '#a335ee', symbol: '\u2605\u2605' },
  LEGENDARY: { name: 'Legendary', color: '#ff8000', symbol: '\u2605\u2605\u2605' },
  BRAINROT: { name: 'Brainrot', color: 'rainbow', symbol: '\u2726' },
};

export interface Card {
  /** `${setId}/${id}`, unique across sets; used as the collection key. */
  key: string;
  setId: string;
  id: string;
  name: string;
  rarity: RarityKey;
  image: string;
  caption?: string;
  flavor?: string;
}

export const toCard = (setId: string, def: CardDefinition): Card => ({
  key: `${setId}/${def.id}`,
  setId,
  id: def.id,
  name: def.name,
  rarity: def.rarity,
  image: cardImageUrl(setId, def.id),
  caption: def.caption,
  flavor: def.flavor,
});

/** Every card in every current set (including drafts, so preview pulls still resolve). */
export const ALL_CARDS: Card[] = SETS.flatMap((set) => set.cards.map((def) => toCard(set.id, def)));

/** Cards you can still pull (released, non-archived sets): what completion achievements count. */
export const COLLECTIBLE_CARDS: Card[] = ALL_CARDS.filter((card) => isOpenable(SETS.find((s) => s.id === card.setId)!));

/**
 * How many of COLLECTIBLE_CARDS a profile has, from its distinct cards per set: archived sets (like
 * Genesis) and drafts are left out of both sides, so it never reads more than the total.
 */
export const collectibleOwned = (uniqueBySet: Record<string, number>): number =>
  SETS.filter(isOpenable).reduce((n, set) => n + Math.min(uniqueBySet[set.id] ?? 0, set.cards.length), 0);

const BY_KEY = new Map(ALL_CARDS.map((c) => [c.key, c]));
// Cards dropped in a newer version of their set still resolve, so players who own them keep them.
for (const set of ALL_SET_VERSIONS) {
  for (const def of set.cards) {
    const key = `${set.id}/${def.id}`;
    if (!BY_KEY.has(key)) BY_KEY.set(key, toCard(set.id, getCardDefinition(set.id, def.id) ?? def));
  }
}

export const getCard = (key: string): Card | undefined => BY_KEY.get(key);

export const getSetCards = (setId: string): Card[] => ALL_CARDS.filter((c) => c.setId === setId);

/** A card's collector number in its set, as its labels print it: 012/120. */
export const cardNumber = (card: { setId: string; key: string }): string => {
  const cards = getSetCards(card.setId);
  const pad = (n: number) => String(n).padStart(3, '0');
  return `${pad(cards.findIndex((c) => c.key === card.key) + 1)}/${pad(cards.length)}`;
};

export const getCardsByRarity = (rarity: RarityKey): Card[] => COLLECTIBLE_CARDS.filter((card) => card.rarity === rarity);

export const cardPoints = engineCardPoints;

/** Score UI cards (matching = same card key). */
export const scoreCards = (cards: readonly { key: string; rarity: RarityKey; isHolo: boolean; finish?: Finish | null; misprint?: boolean }[]): PackScore =>
  scorePack(cards.map((c) => ({ cardId: c.key, rarity: c.rarity, isHolo: c.isHolo, finish: c.finish, misprint: c.misprint })));
