/**
 * Progression without luck: nothing here changes what a pack holds, so every pull stays checkable.
 * Everything is worked out from a player's packs (the same packs a profile link proves), so a title or
 * milestone on someone else's profile is as real as their level.
 *
 * - Levels unlock a title, card backs and pack foils (cosmetic). The title follows your level; you pick which card back and pack foil to use.
 * - Collection Brainrot Score (every card's points, holos at holo points) passes named milestones.
 * - Each set can be completed (every card) and mastered (every card as a holo).
 */

export interface Reward {
  id: string;
  name: string;
  level: number;
}

/** A title for each stretch of levels; you carry the highest one you've reached. */
export const TITLES: readonly Reward[] = [
  { id: 'fresh-pull', name: 'Fresh Pull', level: 1 },
  { id: 'pack-rat', name: 'Pack Rat', level: 3 },
  { id: 'certified-opener', name: 'Certified Opener', level: 5 },
  { id: 'holo-hunter', name: 'Holo Hunter', level: 8 },
  { id: 'meme-historian', name: 'Meme Historian', level: 12 },
  { id: 'brainrot-scholar', name: 'Brainrot Scholar', level: 16 },
  { id: 'aura-farmer', name: 'Aura Farmer', level: 20 },
  { id: 'final-boss', name: 'Final Boss of Ohio', level: 25 },
  { id: 'brainrot-royalty', name: 'Brainrot Royalty', level: 30 },
];

/** Card backs, shown before each card flips. */
export const CARD_BACKS: readonly Reward[] = [
  { id: 'classic', name: 'Classic', level: 1 },
  { id: 'midnight', name: 'Midnight', level: 4 },
  { id: 'vapor', name: 'Vaporwave', level: 7 },
  { id: 'gold', name: 'Gold', level: 10 },
  { id: 'void', name: 'Void', level: 15 },
  { id: 'prism', name: 'Prismatic', level: 20 },
];

/** Finishes for the sealed pack. */
export const PACK_FOILS: readonly Reward[] = [
  { id: 'standard', name: 'Standard', level: 1 },
  { id: 'shimmer', name: 'Shimmer', level: 6 },
  { id: 'gold', name: 'Gold foil', level: 12 },
  { id: 'prism', name: 'Prismatic', level: 18 },
];

const reached = (rewards: readonly Reward[], level: number) => rewards.filter((r) => r.level <= level);

/** The title for a level. */
export const titleFor = (level: number): string => reached(TITLES, level).slice(-1)[0].name;

/** The next reward of any kind still to unlock, if there is one. */
export const nextReward = (level: number): (Reward & { kind: 'title' | 'card back' | 'pack foil' }) | undefined =>
  [
    ...TITLES.map((r) => ({ ...r, kind: 'title' as const })),
    ...CARD_BACKS.map((r) => ({ ...r, kind: 'card back' as const })),
    ...PACK_FOILS.map((r) => ({ ...r, kind: 'pack foil' as const })),
  ]
    .filter((r) => r.level > level)
    .sort((a, b) => a.level - b.level)[0];

/**
 * What a level-up toast says about the rewards between two levels. A title equips itself (there is no
 * picker), so it says so; card backs and pack foils are chosen on Profile, so only they send the player there.
 */
export const levelUpLine = (from: number, level: number): string => {
  const between = (rewards: readonly Reward[]) => rewards.filter((r) => r.level > from && r.level <= level);
  const titles = between(TITLES);
  const choosable = [
    ...between(CARD_BACKS).map((r) => `the ${r.name} card back`),
    ...between(PACK_FOILS).map((r) => `the ${r.name} pack foil`),
  ];
  const parts: string[] = [];
  if (titles.length) parts.push(`Title equipped: ${titles[titles.length - 1].name}.`);
  if (choosable.length) parts.push(`Unlocked ${choosable.join(', ')}. Pick ${choosable.length > 1 ? 'them' : 'it'} on your Profile.`);
  if (parts.length) return parts.join(' ');
  const next = nextReward(level);
  return next ? `Next: ${next.name} at level ${next.level}.` : 'Keep opening.';
};

/** The chosen reward if this level has unlocked it, otherwise the first one (after importing another save, say). */
export const usable = (rewards: readonly Reward[], id: string | undefined, level: number): string =>
  reached(rewards, level).find((r) => r.id === id)?.id ?? rewards[0].id;

/** Collection Brainrot Score milestones. */
export const COLLECTION_MILESTONES: readonly { points: number; name: string }[] = [
  { points: 1_000, name: 'Bronze' },
  { points: 5_000, name: 'Silver' },
  { points: 25_000, name: 'Gold' },
  { points: 100_000, name: 'Platinum' },
  { points: 500_000, name: 'Diamond' },
  { points: 2_000_000, name: 'Brainrot' },
];

/** The milestone reached (if any) and the next one (if any) for a Collection Brainrot Score. */
export const collectionMilestone = (points: number) => {
  const index = COLLECTION_MILESTONES.findIndex((m) => m.points > points);
  const next = index === -1 ? undefined : COLLECTION_MILESTONES[index];
  const current = index === -1 ? COLLECTION_MILESTONES[COLLECTION_MILESTONES.length - 1] : COLLECTION_MILESTONES[index - 1];
  return { current, next };
};

/** How far a set is done: 'master' (every card as a holo), 'complete' (every card) or neither. */
export const setProgress = (owned: number, holoOwned: number, size: number): 'master' | 'complete' | null =>
  size > 0 && holoOwned >= size ? 'master' : size > 0 && owned >= size ? 'complete' : null;
