/**
 * One card version's numbers for the viewer and the per-card share: its points (no pack multiplier)
 * and how often a pack of its set has it, e.g. "400 pts · 1 in 2,400 packs".
 */
import { cardPoints, versionPackChance, type Rarity } from '../engine';
import { getLatestSet, isOpenable } from '../content/sets';
import type { CardVersion } from './versions';

/** The N of "1 in N": two significant figures with thousands separators, one decimal under 10 ("2.5", "13", "2,400"). */
export const formatOneIn = (n: number): string =>
  (n < 10 ? Math.round(n * 10) / 10 : Number(n.toPrecision(2))).toLocaleString('en-US');

/** "1 in N packs" with N from `formatOneIn`, or "Most packs" above 1/2. */
export const packOddsText = (chance: number | null): string | null => {
  if (chance === null || !(chance > 0)) return null;
  if (chance > 0.5) return 'Most packs';
  return `1 in ${formatOneIn(1 / chance)} packs`;
};

export interface CardStats {
  points: number;
  /** Chance a pack of the card's current set has this exact version; null when unknown or its set can't be opened. */
  chance: number | null;
  /** "400 pts · 1 in 2,400 packs", or just the points when the chance is unknown. */
  line: string;
}

export const cardStats = (card: { setId: string; id: string; rarity: Rarity }, version: CardVersion): CardStats => {
  const points = cardPoints(card.rarity, version.isHolo, version.finish, version.misprint);
  const set = getLatestSet(card.setId);
  const chance = set && isOpenable(set) ? versionPackChance(set, { cardId: card.id, ...version }) : null;
  const odds = packOddsText(chance);
  return { points, chance, line: `${points.toLocaleString('en-US')} pts${odds ? ` · ${odds}` : ''}` };
};
