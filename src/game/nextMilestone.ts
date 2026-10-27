import type { SetDefinition } from '../engine';
import type { CollectionItem } from '../types';
import { isCardOwned } from './versions';
import { nextReward } from './progression';
import { xpForLevel } from '../engine/profile';

export interface NextMilestoneGoal {
  kind: 'cosmetic' | 'set-complete' | 'set-master';
  title: string;
  targetName: string;
  detail: string;
  progressText: string;
  progressPct: number;
  actionText: string;
  actionTarget: 'rewards' | 'cards';
  previewBadge?: string;
}

export const getNextMilestone = (
  level: number,
  xp: number,
  set: SetDefinition,
  collection: Record<string, Pick<CollectionItem, 'normalCount' | 'holoCount'> | undefined>,
): NextMilestoneGoal => {
  const nextCosmetic = nextReward(level);
  const cards = set.cards ?? [];
  const ownedCards = cards.filter((c) => isCardOwned(collection[`${set.id}/${c.id}`])).length;
  const holoOwned = cards.filter((c) => (collection[`${set.id}/${c.id}`]?.holoCount ?? 0) > 0).length;
  const setCardsTotal = cards.length;

  // Next cosmetic unlock if 1 level away
  const cosmeticNextLevel = nextCosmetic && nextCosmetic.level <= level + 1;

  if (cosmeticNextLevel && nextCosmetic) {
    const currentLevelXp = xpForLevel(level);
    const targetLevelXp = xpForLevel(nextCosmetic.level);
    const pct = targetLevelXp > currentLevelXp
      ? Math.min(100, Math.max(0, Math.round(((xp - currentLevelXp) / (targetLevelXp - currentLevelXp)) * 100)))
      : 0;

    return {
      kind: 'cosmetic',
      title: 'Next cosmetic unlock',
      targetName: `${nextCosmetic.name} (${nextCosmetic.kind})`,
      detail: `Level ${nextCosmetic.level} cosmetic (does not change odds)`,
      progressText: `${pct}% to Level ${nextCosmetic.level}`,
      progressPct: pct,
      actionText: 'Select rewards',
      actionTarget: 'rewards',
      previewBadge: `Lvl ${nextCosmetic.level}`,
    };
  }

  // If active set is not yet complete
  if (setCardsTotal > 0 && ownedCards < setCardsTotal) {
    const pct = Math.round((ownedCards / setCardsTotal) * 100);
    const remaining = setCardsTotal - ownedCards;
    return {
      kind: 'set-complete',
      title: 'Set milestone',
      targetName: `${set.name} Complete`,
      detail: `${ownedCards}/${setCardsTotal} cards collected (${remaining} to go)`,
      progressText: `${pct}%`,
      progressPct: pct,
      actionText: 'View binder',
      actionTarget: 'cards',
      previewBadge: `${ownedCards}/${setCardsTotal}`,
    };
  }

  // If active set is complete but not mastered
  if (setCardsTotal > 0 && ownedCards >= setCardsTotal && holoOwned < setCardsTotal) {
    const pct = Math.round((holoOwned / setCardsTotal) * 100);
    const remaining = setCardsTotal - holoOwned;
    return {
      kind: 'set-master',
      title: 'Set mastery',
      targetName: `${set.name} Master`,
      detail: `${holoOwned}/${setCardsTotal} holos collected (${remaining} to go)`,
      progressText: `${pct}% holo`,
      progressPct: pct,
      actionText: 'View binder',
      actionTarget: 'cards',
      previewBadge: `${holoOwned}/${setCardsTotal}`,
    };
  }

  // Fallback to remaining cosmetic rewards if any
  if (nextCosmetic) {
    const currentLevelXp = xpForLevel(level);
    const targetLevelXp = xpForLevel(nextCosmetic.level);
    const pct = targetLevelXp > currentLevelXp
      ? Math.min(100, Math.max(0, Math.round(((xp - currentLevelXp) / (targetLevelXp - currentLevelXp)) * 100)))
      : 0;

    return {
      kind: 'cosmetic',
      title: 'Next cosmetic unlock',
      targetName: `${nextCosmetic.name} (${nextCosmetic.kind})`,
      detail: `Level ${nextCosmetic.level} cosmetic (does not change odds)`,
      progressText: `${pct}% to Level ${nextCosmetic.level}`,
      progressPct: pct,
      actionText: 'Select rewards',
      actionTarget: 'rewards',
      previewBadge: `Lvl ${nextCosmetic.level}`,
    };
  }

  // All cosmetics and active set mastered
  return {
    kind: 'set-master',
    title: 'Milestone reached',
    targetName: `${set.name} Mastered`,
    detail: 'All cards and cosmetics unlocked! Keep opening for high scores.',
    progressText: '100%',
    progressPct: 100,
    actionText: 'View binder',
    actionTarget: 'cards',
    previewBadge: 'Master',
  };
};
