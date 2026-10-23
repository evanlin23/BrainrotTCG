import { dailyPulls, HALL_OF_FAME_DAILY_TOP, HALL_OF_FAME_TOP, topPulls, utcDay, type RankableEntry } from './hallOfFame';
import { compareRanked, packBoard, receiptTime, type Coverage, type RankKey, type RankingSnapshot } from './rankings';
import { SCORING_ERA } from './scoring';

/**
 * The published rankings (docs/ARCHITECTURE.md, "Ranking boards"): rankings.json holds Best packs
 * snapshots of all time and of the build's UTC day and the day before, and lists the monthly daily
 * archives, rankings/daily-YYYY-MM.json, which keep each past UTC day's top. A day is rebuilt while it
 * is today or yesterday, and after that each deploy copies it from the deployed archive unchanged
 * (less any entry since removed), since the issues that would rebuild it are no longer all listed.
 */
export const RANKINGS_FILE_VERSION = 1;
export const DAILY_ARCHIVE_VERSION = 1;
/** Places on each published board and on each archived day. */
export const RANKINGS_BOARD_SIZE = 10;

/** A Hall of Fame entry as the build publishes it (the fields the rankings files keep). */
export interface PublishedPull extends RankableEntry {
  issue: number;
  name: string;
  receipt?: 'verification';
}

/** A ranked pull in the rankings files: no proof (its issue links to it), so a day stays small. */
export interface ArchivedPull {
  id: string;
  issue: number;
  setId: string;
  hand: string;
  score: number;
  name: string;
  submittedAt: string;
  receipt?: 'verification';
}

/** The fields in the order the files write them. */
export const archivedPull = (e: ArchivedPull): ArchivedPull => ({
  id: e.id,
  issue: e.issue,
  setId: e.setId,
  hand: e.hand,
  score: e.score,
  name: e.name,
  submittedAt: e.submittedAt,
  ...(e.receipt === undefined ? {} : { receipt: e.receipt }),
});

export type PublishedBoard = Omit<RankingSnapshot, 'entries'> & { entries: ArchivedPull[] };

export interface RankingsFile {
  schemaVersion: number;
  generatedAt: string;
  allTime: PublishedBoard;
  /** The build's UTC day and the day before, newest first. */
  days: { day: string; board: PublishedBoard }[];
  /** Months with a daily archive, oldest first. */
  archive: string[];
}

const rankKeyOf = (e: ArchivedPull): RankKey => ({ id: e.id, pullId: e.id, score: e.score, firstReceivedAt: receiptTime(e.submittedAt), scoringEra: SCORING_ERA });

/** What a list cut at `top` places holds in full: everything, or everything down to its last entry. */
const coverageOf = (kept: readonly ArchivedPull[], top: number): Coverage =>
  kept.length < top ? { kind: 'all' } : { kind: 'through', last: rankKeyOf(kept[kept.length - 1]) };

const board = (kept: readonly PublishedPull[], top: number, generatedAt: string): PublishedBoard => {
  const snapshot = packBoard(kept, { generatedAt, capacity: RANKINGS_BOARD_SIZE, coverage: coverageOf(kept, top) });
  return { ...snapshot, entries: snapshot.entries.map(archivedPull) };
};

/**
 * rankings.json from the published list (listToPublish's): the boards rank the same top pulls and
 * daily tops the list carries, so each is certified as far as the list's own cut.
 */
export const rankingsFile = (
  published: readonly PublishedPull[],
  { generatedAt, days, archive }: { generatedAt: string; days: readonly string[]; archive: readonly string[] },
): RankingsFile => ({
  schemaVersion: RANKINGS_FILE_VERSION,
  generatedAt,
  allTime: board(topPulls(published), HALL_OF_FAME_TOP, generatedAt),
  days: days.map((day) => ({ day, board: board(dailyPulls(published, day), HALL_OF_FAME_DAILY_TOP, generatedAt) })),
  archive: [...archive],
});

/** One month of past days' tops, best first, keyed by UTC day (days with no entries are left out). */
export interface DailyArchive {
  schemaVersion: number;
  month: string;
  days: Record<string, ArchivedPull[]>;
}

/** The archive's one text: days in order, fields in archivedPull's order. */
export const serializeDailyArchive = (a: DailyArchive): string =>
  JSON.stringify(
    {
      schemaVersion: a.schemaVersion,
      month: a.month,
      days: Object.fromEntries(Object.keys(a.days).sort().map((day) => [day, a.days[day].map(archivedPull)])),
    },
    null,
    1,
  ) + '\n';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const isMonth = (month: unknown): month is string => typeof month === 'string' && MONTH.test(month);

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const hasKeys = (x: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(x);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(x, k));
};
const isTime = (t: unknown): t is string => {
  try {
    return typeof t === 'string' && !!receiptTime(t);
  } catch {
    return false;
  }
};

const ARCHIVED_KEYS = ['id', 'issue', 'setId', 'hand', 'score', 'name', 'submittedAt'] as const;
const isArchivedPull = (e: unknown): e is ArchivedPull =>
  isRecord(e) &&
  hasKeys(e, e.receipt === undefined ? ARCHIVED_KEYS : [...ARCHIVED_KEYS, 'receipt']) &&
  typeof e.id === 'string' &&
  e.id !== '' &&
  Number.isSafeInteger(e.issue) &&
  (e.issue as number) > 0 &&
  typeof e.setId === 'string' &&
  typeof e.hand === 'string' &&
  Number.isSafeInteger(e.score) &&
  typeof e.name === 'string' &&
  isTime(e.submittedAt) &&
  (e.receipt === undefined || e.receipt === 'verification');

/**
 * A deployed month's archive, checked in full: exactly the fields above, only days of that month,
 * 1 to RANKINGS_BOARD_SIZE entries a day, each received on its day, each pull once, in ranking order,
 * and written exactly as serializeDailyArchive writes it, so carrying a day forward copies its bytes.
 * Anything else throws.
 */
export const parseDailyArchive = (text: string, month: string): DailyArchive => {
  const fail = (why: string): never => {
    throw new Error(`The daily archive for ${month} ${why}`);
  };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail("isn't JSON");
  }
  if (!isRecord(data) || !hasKeys(data, ['schemaVersion', 'month', 'days'])) return fail("doesn't have exactly schemaVersion, month and days");
  if (data.schemaVersion !== DAILY_ARCHIVE_VERSION) return fail(`has schema version ${String(data.schemaVersion)}`);
  if (!isMonth(month) || data.month !== month) return fail(`names month ${String(data.month)}`);
  if (!isRecord(data.days)) return fail("has no days");
  const days: Record<string, ArchivedPull[]> = {};
  for (const [day, list] of Object.entries(data.days)) {
    if (!DAY.test(day) || utcDay(`${day}T00:00:00Z`) !== day || !day.startsWith(`${month}-`)) return fail(`has a day ${day} outside the month`);
    if (!Array.isArray(list) || list.length < 1 || list.length > RANKINGS_BOARD_SIZE) return fail(`has ${day} without 1 to ${RANKINGS_BOARD_SIZE} entries`);
    for (const [i, e] of list.entries()) {
      if (!isArchivedPull(e)) return fail(`has a malformed entry on ${day}`);
      if (utcDay(e.submittedAt) !== day) return fail(`has an entry on ${day} received on ${utcDay(e.submittedAt)}`);
      if (i > 0 && compareRanked(rankKeyOf(list[i - 1] as ArchivedPull), rankKeyOf(e)) >= 0) return fail(`has ${day} out of order or with a pull twice`);
    }
    if (new Set(list.map((e: ArchivedPull) => e.id)).size !== list.length) return fail(`has a pull twice on ${day}`);
    days[day] = list as ArchivedPull[];
  }
  const archive: DailyArchive = { schemaVersion: DAILY_ARCHIVE_VERSION, month, days };
  if (serializeDailyArchive(archive) !== text) return fail("isn't written in its one form");
  return archive;
};

/**
 * The month's archive after a build: its open days (today and yesterday) as just ranked, and every
 * other day copied from the previous archive, less the entries `keep` turns down (a removed entry's
 * place isn't refilled: the runners-up were never kept). Null when no day has an entry.
 */
export const mergeDailyArchive = (
  previous: DailyArchive | null,
  month: string,
  open: Readonly<Record<string, readonly ArchivedPull[]>>,
  keep: (e: ArchivedPull) => boolean,
): DailyArchive | null => {
  if (previous && previous.month !== month) throw new RangeError(`The ${previous.month} archive was given as ${month}'s`);
  const days: Record<string, ArchivedPull[]> = {};
  for (const [day, list] of Object.entries(previous?.days ?? {})) {
    const kept = Object.prototype.hasOwnProperty.call(open, day) ? [] : list.filter(keep);
    if (kept.length) days[day] = kept;
  }
  for (const [day, list] of Object.entries(open)) if (day.startsWith(`${month}-`) && list.length) days[day] = list.slice(0, RANKINGS_BOARD_SIZE).map(archivedPull);
  return Object.keys(days).length ? { schemaVersion: DAILY_ARCHIVE_VERSION, month, days } : null;
};

const RANKINGS_KEYS = ['schemaVersion', 'generatedAt', 'allTime', 'days', 'archive'] as const;

/**
 * The archive months a deployed rankings.json lists, after checking its outline: exactly its fields,
 * this schema version, a receipt-form time, and months in order, each once. Its boards are rebuilt by
 * every build, so only what is carried forward is read. Anything else throws.
 */
export const parseRankingsFile = (text: string): string[] => {
  const fail = (why: string): never => {
    throw new Error(`The deployed rankings.json ${why}`);
  };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail("isn't JSON");
  }
  if (!isRecord(data) || !hasKeys(data, RANKINGS_KEYS)) return fail(`doesn't have exactly ${RANKINGS_KEYS.join(', ')}`);
  if (data.schemaVersion !== RANKINGS_FILE_VERSION) return fail(`has schema version ${String(data.schemaVersion)}`);
  if (!isTime(data.generatedAt) || !isRecord(data.allTime) || !Array.isArray(data.days)) return fail('is malformed');
  const months = data.archive;
  if (!Array.isArray(months) || !months.every(isMonth) || months.some((m, i) => i > 0 && months[i - 1] >= m)) return fail('lists archive months out of order');
  return months;
};
