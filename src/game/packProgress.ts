import { cardPoints, scoreCards } from '../data/cards';
import {
  checkCollectionAchievements,
  checkPackAchievements,
  checkPackMilestones,
  checkPackScoreAchievements,
} from '../utils/achievementChecks';
import type { AchievementData, CollectionItem, HallOfFameData, Stats } from '../types';
import type { OpenedPack } from './pulls';

/** The progress one recorded pack changes. */
export type PackProgress = { stats: Stats; collection: Record<string, CollectionItem>; hallOfFame: HallOfFameData };

export interface PackRecorded {
  progress: PackProgress;
  /**
   * Achievements the pack earns, in the order to announce them (score, pack milestones, collection,
   * the pack's cards). Ids already unlocked can repeat: the caller skips them as it unlocks.
   */
  unlocks: string[];
}

/**
 * A pack being recorded, as an event: the progress after it and the achievements it unlocks. Pure, so
 * App only applies the result. A pack put back on the shelf (`counted`) counted when it opened (stats,
 * pack milestones): it only adds its cards.
 */
export const recordPack = (
  from: PackProgress,
  pack: Pick<OpenedPack, 'cards' | 'counted' | 'setId' | 'setVersion' | 'nonce' | 'publicKeyHex'>,
  achievements: Record<string, AchievementData | number>,
  now = Date.now(),
): PackRecorded => {
  const counted = pack.counted === true;
  const newCards = pack.cards;
  const pullRef = { setId: pack.setId, setVersion: pack.setVersion, nonce: pack.nonce, publicKeyHex: pack.publicKeyHex };
  const { points: packValue, hand: pokerHand, score } = scoreCards(newCards);

  const updatedStats: Stats = {
    ...from.stats,
    packsOpened: (from.stats.packsOpened || 0) + 1,
    holoCards: { ...from.stats.holoCards },
  };

  // Update highest pack value - compare against previous state
  if (score > (from.stats.highestPackFlexValue || from.stats.highestPackValue || 0)) {
    updatedStats.highestPackFlexValue = score;
    updatedStats.highestPackBaseValue = packValue;
    updatedStats.highestPackMultiplier = pokerHand.multiplier;
    updatedStats.highestPackHandName = pokerHand.name;
    updatedStats.highestPackCards = newCards;
    updatedStats.highestPackRef = pullRef;
    updatedStats.highestPackLegacy = false;
  }

  // Track holo cards
  newCards.forEach(card => {
    if (card.isHolo) {
      updatedStats.holoCards[card.key] = true;
    }
  });
  const stats = counted ? from.stats : updatedStats;

  // Update collection - track holo and normal counts separately
  const updatedCollection = { ...from.collection };
  const normalCounts: Record<string, number> = {};
  const holoCounts: Record<string, number> = {};
  newCards.forEach((card) => {
    if (card.isHolo) {
      holoCounts[card.key] = (holoCounts[card.key] || 0) + 1;
    } else {
      normalCounts[card.key] = (normalCounts[card.key] || 0) + 1;
    }
  });

  // Get all unique card IDs from this pack
  const cardIds = new Set(newCards.map(c => c.key));
  cardIds.forEach((cardId) => {
    const card = newCards.find(c => c.key === cardId);
    if (!card) return;
    const existing = updatedCollection[cardId];
    const finishes = { ...existing?.finishes };
    let misprints = existing?.misprints ?? 0;
    let modifierPoints = existing?.modifierPoints ?? 0;
    for (const copy of newCards.filter((c) => c.key === cardId)) {
      if (copy.finish) finishes[copy.finish] = (finishes[copy.finish] ?? 0) + 1;
      if (copy.misprint) misprints++;
      modifierPoints += cardPoints(copy.rarity, copy.isHolo, copy.finish, copy.misprint) - cardPoints(copy.rarity, copy.isHolo);
    }
    updatedCollection[cardId] = {
      card: { key: card.key, setId: card.setId, id: card.id, name: card.name, rarity: card.rarity, image: card.image },
      normalCount: (existing?.normalCount || 0) + (normalCounts[cardId] || 0),
      holoCount: (existing?.holoCount || 0) + (holoCounts[cardId] || 0),
      ...(Object.keys(finishes).length ? { finishes } : {}),
      ...(misprints ? { misprints } : {}),
      ...(modifierPoints ? { modifierPoints } : {}),
    };
  });

  // Check Hall of Fame milestones
  const updatedHallOfFame = { ...from.hallOfFame };
  const cardCounts: Record<string, number> = {};
  newCards.forEach(c => {
    cardCounts[c.id] = (cardCounts[c.id] || 0) + 1;
  });
  const maxCount = Math.max(...Object.values(cardCounts));

  // First 4 of a kind
  if (maxCount >= 4 && !from.hallOfFame.first4OfAKind) {
    const cardId = Object.entries(cardCounts).find(([, count]) => count >= 4)?.[0];
    if (cardId) {
      updatedHallOfFame.first4OfAKind = { achieved: true, date: now, cardId };
    }
  }

  // First full house
  const counts = Object.values(cardCounts);
  const hasThree = counts.some(c => c >= 3);
  const hasTwo = counts.filter(c => c >= 2).length >= 2;
  if (hasThree && hasTwo && !from.hallOfFame.firstFullHouse) {
    updatedHallOfFame.firstFullHouse = { achieved: true, date: now, cards: cardCounts };
  }

  const unlocks = [
    ...checkPackScoreAchievements(score, {}),
    ...(counted ? [] : checkPackMilestones(stats.packsOpened, achievements)),
    ...checkCollectionAchievements(updatedCollection, stats, achievements),
    ...checkPackAchievements(newCards, achievements),
  ];
  return { progress: { stats, collection: updatedCollection, hallOfFame: updatedHallOfFame }, unlocks };
};
