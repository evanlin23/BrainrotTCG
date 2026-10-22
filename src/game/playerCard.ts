/**
 * The player card you can share from your profile: an image of your level, title, numbers, set
 * progress and best pull (drawn by renderProfilePoster), with a QR code for the profile link that
 * proves all of it.
 */
import { xpForLevel, type ProfileStats } from '../engine';
import { COLLECTIBLE_CARDS, collectibleOwned, getSetCards } from '../data/cards';
import { SETS, isOpenable, setCode } from '../content/sets';
import { renderProfilePoster, type ProfilePosterInput } from './bragImage';
import { collectionMilestone, setProgress, titleFor } from './progression';
import { toCardsWithMeta } from './pulls';

export const playerCardInput = (stats: ProfileStats, player: { name: string; fingerprint: string }, url?: string): ProfilePosterInput => {
  const { current, next } = collectionMilestone(stats.points);
  const best = stats.best.find((p) => p.cards.length > 0);
  return {
    playerName: player.name,
    fingerprint: player.fingerprint,
    level: stats.level,
    title: titleFor(stats.level),
    xp: stats.xp,
    levelXp: xpForLevel(stats.level),
    nextLevelXp: xpForLevel(stats.level + 1),
    packs: stats.packs,
    unique: collectibleOwned(stats.uniqueBySet),
    totalCards: COLLECTIBLE_CARDS.length,
    holos: stats.holos,
    bestScore: best?.score.score ?? 0,
    points: stats.points,
    milestone: current?.name,
    nextMilestone: next,
    milestoneFloor: current?.points ?? 0,
    // The sets you can open, plus any other you have cards from (like Genesis).
    sets: SETS.filter((s) => isOpenable(s) || stats.uniqueBySet[s.id]).map((set) => {
      const have = stats.uniqueBySet[set.id] ?? 0;
      const size = getSetCards(set.id).length;
      return { code: setCode(set), color: set.palette?.[0], have, size, done: setProgress(have, stats.holoUniqueBySet[set.id] ?? 0, size) };
    }),
    best: best && {
      cards: toCardsWithMeta(best.cards, best.set),
      hand: best.score.hand.name,
      score: best.score.score,
      setName: best.set.name,
    },
    url,
  };
};

export const renderPlayerCard = (stats: ProfileStats, player: { name: string; fingerprint: string }, url?: string): Promise<Blob> =>
  renderProfilePoster(playerCardInput(stats, player, url));
