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

/** Best cards (the top 10 card instances of all time), and each card's own best versions board. */
export const CARD_BOARD_SIZE = 10;

/** Best packs, Best cards, and one card's best versions (`card` names which). */
export type RankingScope = 'packs' | 'cards' | 'card-versions';

/** What every ranked entry carries. */
export interface RankKey {
  /** Its identity: the pull id for a pack, `${pullId}#${slot}` for a card instance. */
  id: string;
  pullId: string;
  /** Card instances only: the card's 0-based position in its pack. */
  slot?: number;
  /** Packs: the Brainrot Score. Cards: the card's own points, before the combo multiplier. */
  score: number;
  /**
   * When the pull was first verified: an ISO 8601 UTC time (receiptTime). selectBoard and rebuildBoard
   * rewrite it as receiptTime does before comparing; compareRanked compares it as a plain string, so
   * it takes receiptTime's form only.
   */
  firstReceivedAt: string;
  /** The SCORING_ERA the score was computed under. */
  scoringEra: number;
}

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const RECEIPT_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/**
 * A receipt time in one format (toISOString's, with milliseconds), so that GitHub's "…:07Z" and the
 * client's "…:07.123Z" compare by instant as plain strings. It takes only those two forms of an
 * ISO 8601 UTC time (YYYY-MM-DDTHH:MM:SS, then optionally .fff, then Z) naming a real instant, and
 * throws a RangeError on anything else: another offset, a date alone, or a day or hour that would
 * roll over (Feb 30, 24:00), which Date.parse would accept.
 */
export const receiptTime = (t: string): string => {
  const ms = RECEIPT_TIME.test(t) ? Date.parse(t) : NaN;
  const iso = Number.isNaN(ms) ? '' : new Date(ms).toISOString();
  if (iso !== (t.length === 20 ? `${t.slice(0, 19)}.000Z` : t)) throw new RangeError(`Not a receipt time: ${t}`);
  return iso;
};

/**
 * The one ranking order, best first: higher score, then the earlier first receipt, then the pull id,
 * then (within one pull) the later slot, as revealOrder shows it last. The pack summary's
 * bestPullOrder lists the earlier of two equal cards first instead. Receipt times are compared as
 * plain strings, so both keys must hold receiptTime's form (selectBoard rewrites them first).
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
  /** The card a card-versions board ranks (cardKey); absent on every other scope. */
  card?: string;
  capacity: number;
  scoringEra: number;
  completeness: Completeness;
  generatedAt: string;
  /** The latest first receipt among the ranked pulls (null when there were none). */
  latestReceivedAt: string | null;
  /**
   * How far down the ranking `entries` hold every candidate there is: everything (all), everything at
   * or above an entry (through), or everything scoring at least a minimum (min-score). A rebuild
   * starts from it, so the bound survives removing every entry.
   */
  certifiedThrough: Coverage;
  /** Inputs; duplicates, other eras and entries the coverage can't place are left off the board. */
  sources: { candidates: number; duplicates: number; otherEra: number; uncertain: number };
  entries: T[];
}

export interface BoardOptions {
  scope: RankingScope;
  /** Recorded on the snapshot; required for card-versions, refused otherwise. */
  card?: string;
  capacity: number;
  generatedAt: string;
  /** Defaults to the current SCORING_ERA. */
  scoringEra?: number;
  /** Defaults to all. */
  coverage?: Coverage;
}

const rankKey = ({ id, pullId, slot, score, firstReceivedAt, scoringEra }: RankKey): RankKey =>
  slot === undefined ? { id, pullId, score, firstReceivedAt, scoringEra } : { id, pullId, slot, score, firstReceivedAt, scoringEra };

/** The entry with its receipt time in receiptTime's form (the same object when it already is). */
const normalized = <T extends RankKey>(e: T): T => {
  const firstReceivedAt = receiptTime(e.firstReceivedAt);
  return firstReceivedAt === e.firstReceivedAt ? e : { ...e, firstReceivedAt };
};

/** The coverage with a through bound's receipt time in receiptTime's form (the same object when it already is). */
const normalizedCoverage = (coverage: Coverage): Coverage => {
  if (coverage.kind !== 'through' || !coverage.last) return coverage;
  const last = normalized(coverage.last);
  return last === coverage.last ? coverage : { kind: 'through', last };
};

const covers = (coverage: Coverage, e: RankKey): boolean =>
  coverage.kind === 'all' ||
  (coverage.kind === 'min-score' ? e.score >= coverage.score : !!coverage.last && compareRanked(e, coverage.last) <= 0);

const proofOf = (e: RankKey): unknown => (e as { proof?: unknown }).proof;

/** Whether a carries a proof that sorts before b's: a deterministic pick between two copies of one entry. */
const lowerProof = (a: RankKey, b: RankKey): boolean => {
  const pa = proofOf(a);
  const pb = proofOf(b);
  return typeof pa === 'string' && typeof pb === 'string' && pa < pb;
};

/** The card a card-versions candidate is an instance of (cardKey), if it names one. */
const cardOf = (e: RankKey): string | undefined => {
  const { setId, cardId } = e as { setId?: unknown; cardId?: unknown };
  return typeof setId === 'string' && typeof cardId === 'string' ? cardKey(setId, cardId) : undefined;
};

/** Each pull's best entry (compareRanked), so repeated copies of a card in one pack hold one place. */
const bestPerPull = <T extends RankKey>(entries: Iterable<T>): T[] => {
  const best = new Map<string, T>();
  for (const e of entries) {
    const kept = best.get(e.pullId);
    if (!kept || compareRanked(e, kept) < 0) best.set(e.pullId, e);
  }
  return [...best.values()];
};

/**
 * Rank candidates into a board. Each id counts once: its earliest receipt, then (on a tie between two
 * that carry proofs) the lower proof text, then the first given. A card-versions board names one card:
 * a candidate of another card throws, and each pull holds one place, its best instance of the card
 * (the others count as duplicates).
 * Candidates from another scoring era can't be compared, so any of them leaves the board empty and
 * partial until they are re-derived. Otherwise the board takes the best `capacity` entries the
 * coverage certifies, and is complete when that fills it or the coverage is everything. Receipt times
 * (the candidates' and a through coverage's last entry's) are rewritten as receiptTime writes them
 * before anything is compared, so they compare by instant; one that isn't a receipt time throws.
 */
export const selectBoard = <T extends RankKey>(candidates: readonly T[], options: BoardOptions): RankingSnapshot<T> => {
  const { scope, card, capacity, generatedAt, scoringEra = SCORING_ERA } = options;
  if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError(`Board capacity must be a positive integer, got ${capacity}`);
  if ((scope === 'card-versions') !== (card !== undefined)) throw new RangeError(`A card is named by card-versions boards only (scope ${scope})`);
  const coverage = normalizedCoverage(options.coverage ?? { kind: 'all' });
  const earliest = new Map<string, T>();
  let otherEra = 0;
  for (const c of candidates.map(normalized)) {
    if (card !== undefined && cardOf(c) !== card) throw new RangeError(`The ${card} board was given ${c.id}, an instance of ${cardOf(c) ?? 'no card'}`);
    const kept = earliest.get(c.id);
    if (c.scoringEra !== scoringEra) otherEra++;
    else if (!kept || c.firstReceivedAt < kept.firstReceivedAt || (c.firstReceivedAt === kept.firstReceivedAt && lowerProof(c, kept))) earliest.set(c.id, c);
  }
  const unique = scope === 'card-versions' ? bestPerPull(earliest.values()) : [...earliest.values()];
  const ranked = unique.sort(compareRanked);
  const certain = otherEra > 0 ? [] : ranked.filter((e) => covers(coverage, e));
  const complete = otherEra === 0 && (coverage.kind === 'all' || certain.length >= capacity);
  const reason: PartialReason = otherEra > 0 ? 'scoring-changed' : coverage.kind === 'min-score' ? 'below-intake-minimum' : 'runners-up-not-retained';
  const certifiedThrough: Coverage =
    otherEra > 0 ? { kind: 'through', last: null } : certain.length <= capacity ? coverage : { kind: 'through', last: rankKey(certain[capacity - 1]) };
  return {
    schemaVersion: RANKING_SCHEMA_VERSION,
    scope,
    ...(card === undefined ? {} : { card }),
    capacity,
    scoringEra,
    completeness: complete ? { status: 'complete' } : { status: 'partial', reason },
    certifiedThrough,
    generatedAt,
    latestReceivedAt: ranked.reduce<string | null>((latest, e) => (latest === null || e.firstReceivedAt > latest ? e.firstReceivedAt : latest), null),
    sources: { candidates: candidates.length, duplicates: candidates.length - otherEra - ranked.length, otherEra, uncertain: ranked.length - certain.length },
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
 * order as topPulls (score, then time, then pull id), except that receipt times are compared by
 * instant (receiptTime). Entries must be scored by the current engine.
 */
export const packBoard = <T extends RankableEntry>(entries: readonly T[], { generatedAt, capacity = HALL_OF_FAME_TOP, coverage }: ScopeOptions) =>
  selectBoard(
    entries.map((e) => ({ ...e, pullId: e.id, firstReceivedAt: receiptTime(e.submittedAt), scoringEra: SCORING_ERA })),
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
  firstReceivedAt: receiptTime(firstReceivedAt),
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
  evidence
    .map((e) => ({ ...e, firstReceivedAt: receiptTime(e.firstReceivedAt) }))
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
 * A card's identity across set versions, as the collection, combos and card pages key it. An
 * instance's points come from the rarity and modifiers it was pulled with in its own version, so
 * versions of one card rank together on one board (each entry keeps its setVersion).
 */
export const cardKey = (setId: string, cardId: string): string => `${setId}/${cardId}`;

/**
 * Best versions of each card: one board per cardKey, each ranking only that card's instances by
 * their own points (cardInstances; never the pack's score or hand multiplier). Every board selects
 * and cuts off on its own, so a card whose best pack misses Best packs and Best cards still has its
 * own winners, and an instance from another scoring era leaves only its own card's board partial.
 * Each pack holds one place on a card's board, its best copy of that card (selectBoard), so a pack
 * with the card twice doesn't fill two places. Ties fall to compareRanked: earlier receipt, then pull
 * id, then the later slot. A `through` bound
 * belongs to one board, so it is refused here; rebuild one card's board with rebuildBoard instead.
 * The boards certify only what the instances cover: a pack-score intake minimum (min-score) still
 * holds for each card, since a pack scores at least each of its cards, but it leaves the boards of
 * cards worth less than the minimum empty and partial.
 */
export const cardVersionBoards = (
  instances: readonly CardInstance[],
  { generatedAt, capacity = CARD_BOARD_SIZE, coverage }: ScopeOptions,
): Map<string, RankingSnapshot<CardInstance>> => {
  if (coverage?.kind === 'through') throw new RangeError('A through bound certifies one board; rebuild card boards one at a time');
  const byCard = new Map<string, CardInstance[]>();
  for (const i of instances) {
    const key = cardKey(i.setId, i.cardId);
    const list = byCard.get(key);
    if (list) list.push(i);
    else byCard.set(key, [i]);
  }
  const keys = [...byCard.keys()].sort(order);
  return new Map(keys.map((card) => [card, selectBoard(byCard.get(card)!, { scope: 'card-versions', card, capacity, generatedAt, coverage })]));
};

/**
 * Rebuild a board from what was kept, after pulls are removed or new evidence arrives. `candidates`
 * are the kept entries (or their re-derivations) plus anything new. `coverage` is what the candidates
 * are known to hold in full; it defaults to what the previous board certified (`certifiedThrough`),
 * so a winners-only cache that loses an entry gets a shorter, partial board instead of promoting
 * runners-up it never kept, and a board certified only above the intake minimum stays so. Pass
 * `{ kind: 'all' }` only when the candidates really are every pull there is. After a scoring-era
 * change the previous bound means nothing, so nothing is certified until the caller passes a coverage
 * for candidates re-derived from their proofs. A card-versions board takes only its own card's
 * instances: a candidate of another card throws.
 */
export const rebuildBoard = <T extends RankKey>(
  previous: RankingSnapshot<T>,
  candidates: readonly T[],
  { removed = [], coverage, generatedAt }: { removed?: Iterable<string>; coverage?: Coverage; generatedAt: string },
): RankingSnapshot<T> => {
  const gone = new Set(removed);
  const eraChanged = previous.scoringEra !== SCORING_ERA;
  const board = selectBoard(
    candidates.filter((c) => !gone.has(c.pullId)),
    {
      scope: previous.scope,
      card: previous.card,
      capacity: previous.capacity,
      generatedAt,
      coverage: coverage ?? (eraChanged ? { kind: 'through', last: null } : previous.certifiedThrough),
    },
  );
  const stillStale =
    coverage === undefined && (eraChanged || (previous.completeness.status === 'partial' && previous.completeness.reason === 'scoring-changed'));
  return board.completeness.status === 'partial' && stillStale ? { ...board, completeness: { status: 'partial', reason: 'scoring-changed' } } : board;
};
