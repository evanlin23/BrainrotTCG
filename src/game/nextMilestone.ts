import { levelForXp, xpForLevel, type ProfileStats, type SetDefinition } from '../engine';
import { nextReward, setProgress } from './progression';

/** What the goal reads: the same verified-pack stats a profile shows, so nothing here is counted twice. */
export type MilestoneStats = Pick<ProfileStats, 'xp' | 'uniqueBySet' | 'holoUniqueBySet'>;

export interface NextMilestoneGoal {
  kind: 'cosmetic' | 'set-complete' | 'set-master' | 'done';
  /** The one thing to chase, e.g. "Midnight (card back)". */
  targetName: string;
  /** Why it is worth chasing, in a short phrase. Cosmetic goals say they change no odds. */
  detail: string;
  progressText: string;
  /** Whole percent, never 100 until the goal is actually reached. */
  progressPct: number;
  /** Where the goal's link goes; none once everything is done. */
  action?: { text: string; target: 'rewards' | 'cards' };
}

const percent = (part: number, whole: number) => (whole > 0 ? Math.min(99, Math.max(0, Math.floor((part / whole) * 100))) : 0);

/**
 * The next goal worth showing under a resting pack: a level cosmetic that is a level away, else the
 * selected set's completion, then its mastery, else the next cosmetic further on. The rules (levels,
 * rewards, what completed and mastered mean) are the ones the profile and binder use; this only picks one.
 */
export const getNextMilestone = (stats: MilestoneStats, set: SetDefinition): NextMilestoneGoal => {
  const level = levelForXp(stats.xp);
  const reward = nextReward(level);
  const cosmetic = (): NextMilestoneGoal => {
    const next = reward!;
    const progressPct = percent(stats.xp - xpForLevel(level), xpForLevel(next.level) - xpForLevel(level));
    return {
      kind: 'cosmetic',
      targetName: `${next.name} (${next.kind})`,
      detail: `Level ${next.level} cosmetic: rarity and odds stay the same`,
      progressText: `${progressPct}% to level ${next.level}`,
      progressPct,
      action: { text: next.kind === 'title' ? 'View rewards' : 'Select rewards', target: 'rewards' },
    };
  };
  if (reward && reward.level <= level + 1) return cosmetic();

  const size = set.cards.length;
  const done = setProgress(stats.uniqueBySet[set.id] ?? 0, stats.holoUniqueBySet[set.id] ?? 0, size);
  if (size > 0 && done !== 'master') {
    const completing = done === null;
    const counted = (completing ? stats.uniqueBySet : stats.holoUniqueBySet)[set.id] ?? 0;
    return {
      kind: completing ? 'set-complete' : 'set-master',
      targetName: `${set.name} ${completing ? 'complete' : 'master set'}`,
      detail: `${counted}/${size} ${completing ? 'cards' : 'as holos'}, ${size - counted} to go`,
      progressText: `${counted}/${size}`,
      progressPct: percent(counted, size),
      action: { text: 'View binder', target: 'cards' },
    };
  }
  if (reward) return cosmetic();
  return {
    kind: 'done',
    targetName: size > 0 ? `${set.name} mastered` : 'Every reward unlocked',
    detail: 'Every reward is unlocked',
    progressText: 'Done',
    progressPct: 100,
  };
};
