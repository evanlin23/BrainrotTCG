/**
 * The pack-level takeover (#1293 c): when the last card gives way to the summary, a Full House or better, or a
 * new personal best, takes the whole screen for a moment before the summary's score counts up. Points alone
 * never do. Pure rules, no React: the summary reads them, and the tests pin them.
 */
import { POKER_HANDS, type HandKey, type PokerHand } from '../engine';
import type { PackRecord } from './personalRecords';

export type PackTakeoverReason = 'FIVE_OF_A_KIND' | 'FOUR_OF_A_KIND' | 'FULL_HOUSE' | 'NEW_BEST';

/** The hands that earn it, best first: Full House, 4 of a Kind and 5 of a Kind. */
const HAND_REASONS = ['FIVE_OF_A_KIND', 'FOUR_OF_A_KIND', 'FULL_HOUSE'] as const satisfies readonly HandKey[];

/** What the banner says first. A hand is named as the combo line names it ("Full House", "4 of a Kind"). */
export const PACK_TAKEOVER_KICKER: Record<PackTakeoverReason, string> = {
  FIVE_OF_A_KIND: POKER_HANDS.FIVE_OF_A_KIND.name,
  FOUR_OF_A_KIND: POKER_HANDS.FOUR_OF_A_KIND.name,
  FULL_HOUSE: POKER_HANDS.FULL_HOUSE.name,
  NEW_BEST: 'New best',
};

/**
 * Why a pack earns the takeover, or null: its hand is a Full House or better, else it set a new personal
 * best. A hand outranks a new best (the cause leads; the summary's NEW BEST medal says the rest). `record` is
 * personalRecords' packRecord, the same verdict the summary's NEW BEST medal shows: only an all-time `best`
 * counts, not a set best or a top-3 rank. Points are not an input at all.
 */
export const packTakeoverReason = (hand: Pick<PokerHand, 'name'>, record: PackRecord | null): PackTakeoverReason | null => {
  const byHand = HAND_REASONS.find((key) => POKER_HANDS[key].name === hand.name);
  if (byHand) return byHand;
  return record?.kind === 'best' ? 'NEW_BEST' : null;
};

/** How long the summary's score takes to count up once the takeover has settled. */
export const COUNT_UP_MS = 1_200;

/**
 * The score shown `elapsedMs` into its count-up: 0 at the start, `target` from `durationMs` on, easing out in
 * between so it lands softly. Whole numbers, never past `target`. A target that is not a positive number is shown as is.
 */
export const countUpValue = (target: number, elapsedMs: number, durationMs = COUNT_UP_MS): number => {
  if (!Number.isFinite(target) || target <= 0) return target;
  if (!(elapsedMs > 0)) return 0;
  if (elapsedMs >= durationMs) return target;
  const left = 1 - elapsedMs / durationMs;
  return Math.min(target, Math.floor(target * (1 - left * left * left)));
};
