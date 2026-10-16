import { HOLO_MULTIPLIER, POKER_HANDS, RARITY_POINTS, type PackScore } from './scoring';

/**
 * What counts as Hall of Fame worthy. Shared by the in-game "Submit" button, the inbox, the issue
 * verifier and the deploy, so they can never disagree.
 * A Full House or better (about 1 in 70 packs in the current sets), or a Brainrot
 * Score of at least one holo Brainrot card's worth.
 */
export const HALL_OF_FAME_MIN_MULTIPLIER = POKER_HANDS.FULL_HOUSE.multiplier;
export const HALL_OF_FAME_MIN_SCORE = RARITY_POINTS.BRAINROT * HOLO_MULTIPLIER;

export const qualifiesForHallOfFame = (score: PackScore): boolean =>
  score.hand.multiplier >= HALL_OF_FAME_MIN_MULTIPLIER || score.score >= HALL_OF_FAME_MIN_SCORE;

/**
 * The Hall of Fame keeps the best pulls by score, plus the first of each hand (Full House and up)
 * in each set: about 120 entries however many people play, so it costs the same to build, serve
 * and check at any size.
 */
export const HALL_OF_FAME_TOP = 100;
/** The best pulls of one UTC day ("Today" in Rankings), on top of the all-time list. */
export const HALL_OF_FAME_DAILY_TOP = 50;

/** What the list needs to know about an entry. `id` is its pull id (one entry per pull). */
export interface RankableEntry {
  id: string;
  setId: string;
  hand: string;
  multiplier: number;
  score: number;
  /** When it was first verified (ISO time): earlier wins ties and "firsts". */
  submittedAt: string;
}

const byTime = <T extends RankableEntry>(a: T, b: T) => a.submittedAt.localeCompare(b.submittedAt);
const byRank = <T extends RankableEntry>(a: T, b: T) => b.score - a.score || byTime(a, b);
const firstKey = (e: Pick<RankableEntry, 'setId' | 'hand'>) => `${e.setId}|${e.hand}`;

/** Each pull once (its earliest verification keeps the credit). */
export const uniquePulls = <T extends RankableEntry>(entries: readonly T[]): T[] => {
  const seen = new Set<string>();
  return [...entries].sort(byTime).filter((e) => !seen.has(e.id) && !!seen.add(e.id));
};

/** The best `HALL_OF_FAME_TOP` pulls, best first (ties go to the earlier one). */
export const topPulls = <T extends RankableEntry>(entries: readonly T[]): T[] => uniquePulls(entries).sort(byRank).slice(0, HALL_OF_FAME_TOP);

/** The first verified pull of each hand (Full House and up) in each set, oldest first. */
export const firstPulls = <T extends RankableEntry>(entries: readonly T[]): T[] => {
  const seen = new Set<string>();
  return uniquePulls(entries).filter((e) => e.multiplier >= HALL_OF_FAME_MIN_MULTIPLIER && !seen.has(firstKey(e)) && !!seen.add(firstKey(e)));
};

/**
 * The UTC calendar day of an ISO time, as YYYY-MM-DD. Everyone shares the same day whatever their
 * time zone, so "today" is the same board for every player. An unreadable time has no day ('').
 */
export const utcDay = (iso: string): string => {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? '' : new Date(time).toISOString().slice(0, 10);
};

/** The UTC day before a YYYY-MM-DD day ('' for an unreadable one). */
export const previousUtcDay = (day: string): string => {
  const midnight = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isNaN(midnight) ? '' : new Date(midnight - 86_400_000).toISOString().slice(0, 10);
};

/**
 * The best `HALL_OF_FAME_DAILY_TOP` pulls verified on one UTC day, best first. Ranked like
 * `topPulls`: each pull once, credited to its earliest verification in `entries` (so a pull verified
 * on an earlier day among them doesn't count again), and ties go to the earlier one. The build only
 * passes the last two days' daily-only entries, so this alone can't stop a pull from counting on a
 * later day again: intake turns one down while a `daily` issue from the last eight days carries it
 * (scripts/hall-of-fame.ts), and one filed again after that can count again.
 */
export const dailyPulls = <T extends RankableEntry>(entries: readonly T[], day: string): T[] =>
  uniquePulls(entries)
    .filter((e) => utcDay(e.submittedAt) === day)
    .sort(byRank)
    .slice(0, HALL_OF_FAME_DAILY_TOP);

/**
 * Everything the Hall of Fame keeps: the top pulls, the firsts, and the daily top of each of `days`
 * (UTC, YYYY-MM-DD), each pull once. The daily entries only add to the list, so the top pulls and
 * firsts read from it are the same with or without them.
 */
export const hallOfFameList = <T extends RankableEntry>(entries: readonly T[], days: readonly string[] = []): T[] => {
  const kept = new Map<string, T>();
  for (const e of [...topPulls(entries), ...firstPulls(entries), ...days.flatMap((day) => dailyPulls(entries, day))]) if (!kept.has(e.id)) kept.set(e.id, e);
  return [...kept.values()];
};

/**
 * Why a pull verified now would join the list, or null if it wouldn't. It has to qualify and not be
 * listed already. 'all-time': it beats the lowest of the top pulls (or there's room), or it's the
 * first of its hand in its set. 'daily': it misses those but makes the top of `day` (UTC,
 * YYYY-MM-DD): there's room, or it beats the lowest (a tie goes to the earlier one). Without a day,
 * only the all-time list counts.
 */
export const hallOfFameJoin = (
  pull: { id: string; setId: string; score: PackScore },
  list: readonly RankableEntry[],
  day?: string,
): 'all-time' | 'daily' | null => {
  if (!qualifiesForHallOfFame(pull.score) || list.some((e) => e.id === pull.id)) return null;
  const top = topPulls(list);
  if (top.length < HALL_OF_FAME_TOP || pull.score.score > top[top.length - 1].score) return 'all-time';
  if (pull.score.hand.multiplier >= HALL_OF_FAME_MIN_MULTIPLIER && !list.some((e) => firstKey(e) === firstKey({ setId: pull.setId, hand: pull.score.hand.name }))) return 'all-time';
  if (!day) return null;
  const today = dailyPulls(list, day);
  return today.length < HALL_OF_FAME_DAILY_TOP || pull.score.score > today[today.length - 1].score ? 'daily' : null;
};

/** Whether a pull verified now would join the list, on the all-time list or `day`'s top (see `hallOfFameJoin`). */
export const wouldJoinHallOfFame = (pull: { id: string; setId: string; score: PackScore }, list: readonly RankableEntry[], day?: string): boolean =>
  hallOfFameJoin(pull, list, day) !== null;
