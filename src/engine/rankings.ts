import { HALL_OF_FAME_TOP, type RankableEntry } from './hallOfFame';
import { scorePulled } from './profile';
import { pullId, type VerifiedPull } from './proof';
import { SCORING_ERA, cardPoints } from './scoring';
import type { Finish, PulledCard, Rarity } from './types';

/**
 * Ranking boards: one snapshot schema and one order for every leaderboard (docs/ARCHITECTURE.md,
 * "Ranking boards"). A snapshot says what it ranks (scope), how many places it has (capacity), which
 * scoring rules its scores came from (era), whether its evidence certifies every place (completeness)
 * and when and from what it was built (freshness).
 */
export const RANKING_SCHEMA_VERSION = 1;

/** Best cards: the top 10 card instances of all time. */
export const CARD_BOARD_SIZE = 10;

export type RankingScope = 'packs' | 'cards';

/** What every ranked entry carries. */
export interface RankKey {
  /** Its identity: the pull id for a pack, `${pullId}#${slot}` for a card instance. */
  id: string;
  pullId: string;
  /** Card instances only: the card's 0-based position in its pack. */
  slot?: number;
  /** Packs: the Brainrot Score. Cards: the card's own points, before the combo multiplier. */
  score: number;
  /** When the pull was first verified, as toISOString writes it (compared as a plain string). */
  firstReceivedAt: string;
  /** The SCORING_ERA the score was computed under. */
  scoringEra: number;
}

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The one ranking order, best first: higher score, then the earlier first receipt, then the pull id,
 * then (within one pull) the later slot, as the pack reveal picks a pack's best card.
 */
export const compareRanked = (a: RankKey, b: RankKey): number =>
  b.score - a.score || order(a.firstReceivedAt, b.firstReceivedAt) || order(a.pullId, b.pullId) || (b.slot ?? 0) - (a.slot ?? 0);

/**
 * Which part of the ranking the candidates are known to hold in full:
 * - all: every candidate there is;
 * - through: everything ranking at or above `last` (a previous board's last entry; null for nothing);
 * - min-score: everything scoring at least `score` (what a filtered intake guarantees).
 */
export type Coverage = { kind: 'all' } | { kind: 'through'; last: RankKey | null } | { kind: 'min-score'; score: number };

export type PartialReason =
  /** Entries below the kept ones were dropped (a winners-only cache lost an entry). */
  | 'runners-up-not-retained'
  /** The source only keeps entries above a minimum (the Hall of Fame intake). */
  | 'below-intake-minimum'
  /** Some candidates were scored under other rules and haven't been re-derived from their proofs. */
  | 'scoring-changed';

/** Partial: `entries` is the board's true top, in order, but places after them may be missing. */
export type Completeness = { status: 'complete' } | { status: 'partial'; reason: PartialReason };

export interface RankingSnapshot<T extends RankKey = RankKey> {
  schemaVersion: number;
  scope: RankingScope;
  capacity: number;
  scoringEra: number;
  completeness: Completeness;
  generatedAt: string;
  /** The latest first receipt among the ranked pulls (null when there were none). */
  latestReceivedAt: string | null;
  /** Inputs; duplicates, other eras and entries the coverage can't place are left off the board. */
  sources: { candidates: number; duplicates: number; otherEra: number; uncertain: number };
  entries: T[];
}

export interface BoardOptions {
  scope: RankingScope;
  capacity: number;
  generatedAt: string;
  /** Defaults to the current SCORING_ERA. */
  scoringEra?: number;
  /** Defaults to all. */
  coverage?: Coverage;
}

const covers = (coverage: Coverage, e: RankKey): boolean =>
  coverage.kind === 'all' ||
  (coverage.kind === 'min-score' ? e.score >= coverage.score : !!coverage.last && compareRanked(e, coverage.last) <= 0);

/**
 * Rank candidates into a board. Each id counts once (its earliest receipt; the first given on a tie).
 * Candidates from another scoring era can't be compared, so any of them leaves the board empty and
 * partial until they are re-derived. Otherwise the board takes the best `capacity` entries the
 * coverage certifies, and is complete when that fills it or the coverage is everything.
 */
export const selectBoard = <T extends RankKey>(candidates: readonly T[], options: BoardOptions): RankingSnapshot<T> => {
  const { scope, capacity, generatedAt, scoringEra = SCORING_ERA, coverage = { kind: 'all' } } = options;
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`Board capacity must be a positive integer, got ${capacity}`);
  const earliest = new Map<string, T>();
  let otherEra = 0;
  for (const c of candidates) {
    const kept = earliest.get(c.id);
    if (c.scoringEra !== scoringEra) otherEra++;
    else if (!kept || c.firstReceivedAt < kept.firstReceivedAt) earliest.set(c.id, c);
  }
  const ranked = [...earliest.values()].sort(compareRanked);
  const certain = otherEra > 0 ? [] : ranked.filter((e) => covers(coverage, e));
  const complete = otherEra === 0 && (coverage.kind === 'all' || certain.length >= capacity);
  const reason: PartialReason = otherEra > 0 ? 'scoring-changed' : coverage.kind === 'min-score' ? 'below-intake-minimum' : 'runners-up-not-retained';
  return {
    schemaVersion: RANKING_SCHEMA_VERSION,
    scope,
    capacity,
    scoringEra,
    completeness: complete ? { status: 'complete' } : { status: 'partial', reason },
    generatedAt,
    latestReceivedAt: ranked.reduce<string | null>((latest, e) => (latest === null || e.firstReceivedAt > latest ? e.firstReceivedAt : latest), null),
    sources: { candidates: candidates.length, duplicates: candidates.length - otherEra - earliest.size, otherEra, uncertain: ranked.length - certain.length },
    entries: certain.slice(0, capacity),
  };
};

interface ScopeOptions {
  generatedAt: string;
  capacity?: number;
  coverage?: Coverage;
}

/**
 * Best packs: the Hall of Fame's top pulls through the shared schema. The same entries in the same
 * order as topPulls, except that two pulls tied on both score and time are placed by pull id rather
 * than by input order. Entries must be scored by the current engine.
 */
export const packBoard = <T extends RankableEntry>(entries: readonly T[], { generatedAt, capacity = HALL_OF_FAME_TOP, coverage }: ScopeOptions) =>
  selectBoard(
    entries.map((e) => ({ ...e, pullId: e.id, firstReceivedAt: e.submittedAt, scoringEra: SCORING_ERA })),
    { scope: 'packs', capacity, generatedAt, coverage },
  );

/** A verified pull as the boards take it: re-derived by verifyProof, never a client's claim. */
export interface PackEvidence {
  pullId: string;
  /** The signed proof text it was verified from: what a board entry links to. */
  proof: string;
  setId: string;
  setVersion: number;
  cards: readonly PulledCard[];
  firstReceivedAt: string;
}

export const packEvidence = (pull: VerifiedPull, proof: string, firstReceivedAt: string): PackEvidence => ({
  pullId: pullId(pull.proof),
  proof,
  setId: pull.set.id,
  setVersion: pull.set.version,
  cards: pull.cards,
  firstReceivedAt,
});

/** The same evidence as a Best packs entry, scored as verifyProof scores it: one proof feeds both boards. */
export const packEntry = (e: PackEvidence): RankableEntry & { setVersion: number; proof: string } => {
  const score = scorePulled(e.cards);
  return {
    id: e.pullId,
    setId: e.setId,
    setVersion: e.setVersion,
    hand: score.hand.name,
    multiplier: score.hand.multiplier,
    score: score.score,
    submittedAt: e.firstReceivedAt,
    proof: e.proof,
  };
};

/** One card in one verified pack, with exactly the modifiers it was pulled with. */
export interface CardInstance extends RankKey {
  slot: number;
  setId: string;
  setVersion: number;
  cardId: string;
  rarity: Rarity;
  isHolo: boolean;
  finish: Finish | null;
  misprint: boolean;
  proof: string;
}

/** Two identical cards in different slots of one pack are two instances. */
export const cardInstanceId = (pull: string, slot: number): string => `${pull}#${slot}`;

/**
 * Every card of every pack, scored by cardPoints from its rarity and modifiers (never from a score
 * the evidence carries). Evidence must be engine output, so a malformed pack throws.
 */
export const cardInstances = (evidence: readonly PackEvidence[]): CardInstance[] =>
  [...evidence]
    .sort((a, b) => order(a.firstReceivedAt, b.firstReceivedAt) || order(a.proof, b.proof))
    .flatMap((e) =>
      e.cards.map((c, i): CardInstance => {
        if (c.slot !== i || c.setId !== e.setId || !e.pullId.startsWith(`${e.setId}@${e.setVersion}/`)) {
          throw new Error(`Malformed evidence for ${e.pullId}: position ${i} holds ${c.setId}/${c.cardId} in slot ${c.slot}`);
        }
        return {
          id: cardInstanceId(e.pullId, c.slot),
          pullId: e.pullId,
          slot: c.slot,
          score: cardPoints(c.rarity, c.isHolo, c.finish, c.misprint),
          firstReceivedAt: e.firstReceivedAt,
          scoringEra: SCORING_ERA,
          setId: e.setId,
          setVersion: e.setVersion,
          cardId: c.cardId,
          rarity: c.rarity,
          isHolo: c.isHolo,
          finish: c.finish ?? null,
          misprint: c.misprint ?? false,
          proof: e.proof,
        };
      }),
    );

/** Best cards: the top card instances, ranked by each card's own points. */
export const cardBoard = (evidence: readonly PackEvidence[], { generatedAt, capacity = CARD_BOARD_SIZE, coverage }: ScopeOptions) =>
  selectBoard(cardInstances(evidence), { scope: 'cards', capacity, generatedAt, coverage });

/**
 * Rebuild a board from what was kept, after pulls are removed or new evidence arrives. `candidates`
 * are the kept entries (or their re-derivations) plus anything new. With every candidate kept
 * (`retainedAll`) the result is exact. Otherwise only the places the previous board certified count:
 * a winners-only cache that loses an entry gets a shorter, partial board instead of promoting
 * runners-up it never kept. After a scoring-era change nothing is certified until every candidate is
 * re-derived from its proof.
 */
export const rebuildBoard = <T extends RankKey>(
  previous: RankingSnapshot<T>,
  candidates: readonly T[],
  { removed = [], retainedAll, generatedAt }: { removed?: Iterable<string>; retainedAll: boolean; generatedAt: string },
): RankingSnapshot<T> => {
  const gone = new Set(removed);
  const eraChanged = previous.scoringEra !== SCORING_ERA;
  const heldEverything = previous.completeness.status === 'complete' && previous.entries.length < previous.capacity;
  const last = eraChanged || previous.entries.length === 0 ? null : previous.entries[previous.entries.length - 1];
  const board = selectBoard(
    candidates.filter((c) => !gone.has(c.pullId)),
    { scope: previous.scope, capacity: previous.capacity, generatedAt, coverage: retainedAll || heldEverything ? { kind: 'all' } : { kind: 'through', last } },
  );
  if (board.completeness.status === 'complete') return board;
  const reason: PartialReason =
    eraChanged || board.sources.otherEra > 0
      ? 'scoring-changed'
      : previous.completeness.status === 'partial'
        ? previous.completeness.reason
        : 'runners-up-not-retained';
  return { ...board, completeness: { status: 'partial', reason } };
};
