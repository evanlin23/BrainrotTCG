/**
 * The published rankings files (src/engine/rankingsArchive.ts, written by the Hall of Fame build next
 * to hall-of-fame.json): rankings.json says when the build ran and which months have a daily archive,
 * and rankings/daily-YYYY-MM.json keeps each past UTC day's top. Each file is checked in full with the
 * engine's strict parsers before anything is shown. A missing, unreadable or malformed file reads as
 * null, "no archive", never as an error.
 */
import { parseDailyArchive, parseRankingsFile, previousUtcDay, utcDay, type ArchivedPull } from '../engine';
import { LIST_TTL_MS, LOAD_TIMEOUT_MS } from './hallOfFameList';

export interface PublishedRankings {
  /** When the build wrote the rankings (and hall-of-fame.json with them), from the file itself. */
  generatedAt: string;
  /** The first day still open when it ran (the day before its UTC day): archived days before it are closed. */
  openFrom: string;
  /** Archived months that can hold a closed day, newest first. */
  months: string[];
}

/** A closed UTC day's top, best first, as archived. */
export interface PastDay {
  day: string;
  entries: ArchivedPull[];
}

const fetchText = async (path: string): Promise<string | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}${path}`, { cache: 'no-cache', signal: controller.signal });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

/** rankings.json's text, checked; null if it isn't a rankings file this code can read. */
export const parsePublishedRankings = (text: string): PublishedRankings | null => {
  try {
    const listed = parseRankingsFile(text);
    const { generatedAt } = JSON.parse(text) as { generatedAt: string };
    const openFrom = previousUtcDay(utcDay(generatedAt));
    // A month whose first day is still open has no closed day yet.
    return { generatedAt, openFrom, months: listed.filter((month) => `${month}-01` < openFrom).reverse() };
  } catch {
    return null;
  }
};

/**
 * A month's archive text, checked in full (`parseDailyArchive`: its schema, only that month's days,
 * each cut at RANKINGS_BOARD_SIZE in ranking order, in its one written form), as its closed days,
 * newest first. Days still open when the build ran are left out: Today shows those, and they change
 * until they close. Null if the archive doesn't check.
 */
export const parsePastMonth = (text: string, month: string, rankings: PublishedRankings): PastDay[] | null => {
  if (!rankings.months.includes(month)) return null;
  try {
    const { days } = parseDailyArchive(text, month);
    return Object.keys(days)
      .filter((day) => day < rankings.openFrom)
      .sort()
      .reverse()
      .map((day) => ({ day, entries: days[day] }));
  } catch {
    return null;
  }
};

/**
 * `load`, run at most once every LIST_TTL_MS (as `loadHallOfFame` is), so a tab left open picks up
 * a removal the next time it shows the rankings after that. A load that gives null keeps the last
 * value that loaded (null if none has), and the next call tries again.
 */
const reused = <T>(load: () => Promise<T | null>): (() => Promise<T | null>) => {
  let loading: Promise<T | null> | null = null;
  let loadedAt = 0;
  let last: T | null = null;
  return () => {
    if (loading && Date.now() - loadedAt < LIST_TTL_MS) return loading;
    loadedAt = Date.now();
    const current = load().then((value) => {
      if (value !== null) return (last = value);
      if (loading === current) loading = null;
      return last;
    });
    return (loading = current);
  };
};

/** rankings.json, fetched at most once every five minutes; null if it has never loaded and checked. */
export const loadPublishedRankings = reused(async () => {
  const text = await fetchText('rankings.json');
  return text === null ? null : parsePublishedRankings(text);
});

const months = new Map<string, () => Promise<PastDay[] | null>>();

/**
 * A listed month's closed days, fetched at most once every five minutes for the same rankings.json;
 * null if it has never loaded and checked.
 */
export const loadPastMonth = (rankings: PublishedRankings, month: string): Promise<PastDay[] | null> => {
  if (!rankings.months.includes(month)) return Promise.resolve(null);
  const key = `${rankings.generatedAt} ${month}`;
  let load = months.get(key);
  if (!load) {
    load = reused(async () => {
      const text = await fetchText(`rankings/daily-${month}.json`);
      return text === null ? null : parsePastMonth(text, month, rankings);
    });
    months.set(key, load);
  }
  return load();
};
