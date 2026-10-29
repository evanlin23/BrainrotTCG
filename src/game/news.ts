import { STORAGE_KEYS } from '../constants';

export interface NewsItem {
  id: string;
  title: string;
  date: string;
  category?: 'news' | 'changelog' | 'event';
  tag?: string;
  summary: string;
  link?: { text: string; url: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isValidNewsItem = (item: unknown): item is NewsItem => {
  if (!isRecord(item)) return false;
  if (typeof item.id !== 'string' || !item.id.trim()) return false;
  if (typeof item.title !== 'string' || !item.title.trim()) return false;
  if (typeof item.date !== 'string' || !item.date.trim()) return false;
  if (typeof item.summary !== 'string' || !item.summary.trim()) return false;
  if (item.category !== undefined && typeof item.category !== 'string') return false;
  if (item.tag !== undefined && typeof item.tag !== 'string') return false;
  if (item.link !== undefined) {
    if (!isRecord(item.link)) return false;
    if (typeof item.link.text !== 'string' || typeof item.link.url !== 'string') return false;
  }
  return true;
};

export const parseNews = (raw: unknown): NewsItem[] => {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidNewsItem);
};

export const getDismissedNewsId = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEYS.DISMISSED_NEWS);
  } catch {
    return null;
  }
};

// A dismissal that storage refused (full or blocked) still holds for this visit, so the banner
// does not come back each time it remounts after a pack.
let unsavedDismissal: string | null = null;

export const dismissNewsId = (id: string): boolean => {
  try {
    localStorage.setItem(STORAGE_KEYS.DISMISSED_NEWS, id);
    unsavedDismissal = null;
    return true;
  } catch {
    unsavedDismissal = id;
    return false;
  }
};

export const isNewsDismissed = (id: string): boolean => {
  return unsavedDismissal === id || getDismissedNewsId() === id;
};

export const getLatestUnreadNews = (items: readonly NewsItem[]): NewsItem | null => {
  if (items.length === 0) return null;
  const latest = items[0];
  return isNewsDismissed(latest.id) ? null : latest;
};

let shipped: Promise<NewsItem[]> | undefined;

/**
 * The announcements the build ships (src/content/news.json), newest first, as their own chunk: only a
 * player who has saved a pack ever asks for it, so the first load doesn't carry it, and nothing is
 * fetched. Asked for once at a time (StrictMode asks twice). A chunk that fails to load, or a file that
 * isn't a list, gives no news; a failed load is tried again next time.
 */
export const loadNews = (): Promise<NewsItem[]> => {
  shipped ??= import('../content/news.json').then(
    (module) => parseNews(module.default),
    () => {
      shipped = undefined;
      return [];
    },
  );
  return shipped;
};
