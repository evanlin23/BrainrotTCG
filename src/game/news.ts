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

/** Newest first by date (ISO dates sort as text); entries on one day keep the file's order. */
export const newestFirst = (items: readonly NewsItem[]): NewsItem[] =>
  items.map((item, index) => ({ item, index })).sort((a, b) => (a.item.date === b.item.date ? a.index - b.index : a.item.date < b.item.date ? 1 : -1)).map(({ item }) => item);

export const parseNews = (raw: unknown): NewsItem[] => {
  if (!Array.isArray(raw)) return [];
  return newestFirst(raw.filter(isValidNewsItem));
};

/** The label on an entry: its tag, else its category, else "News". */
export const newsTag = (item: NewsItem): string => item.tag ?? (item.category === 'changelog' ? 'Changelog' : item.category === 'event' ? 'Event' : 'News');

export const getDismissedNewsId = (): string | null => {
  try {
    return localStorage.getItem(STORAGE_KEYS.DISMISSED_NEWS);
  } catch {
    return null;
  }
};

// A dismissal that storage refused (full or blocked) still holds for this visit, so the toast
// does not come back after the next pack.
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

/** A toast's id for an entry; the toast queue (the app's) keys on it, and seeing the toast reads the entry back out. */
const NEWS_TOAST_PREFIX = 'news:';
export const newsToastId = (id: string): string => `${NEWS_TOAST_PREFIX}${id}`;
export const isNewsToastId = (toastId: string): boolean => toastId.startsWith(NEWS_TOAST_PREFIX);

/** The toast for an entry: it opens the What's new page. */
export const newsToast = (item: NewsItem) => ({
  id: newsToastId(item.id),
  kicker: "What's new",
  name: item.title,
  description: item.summary,
  opens: 'news' as const,
});

/** Reading the page reads the newest entry: the toast never follows a visit to the page it opens. */
export const markNewsRead = (items: readonly NewsItem[]): void => {
  if (items.length > 0) dismissNewsId(items[0].id);
};

/**
 * The toasts among these ids are for news that has now been shown or opened: read them. Storage that
 * refuses still holds for the visit (dismissNewsId), so a toast is never shown twice in one.
 */
export const readNewsToasts = (toastIds: readonly string[]): void => {
  for (const toastId of toastIds) if (isNewsToastId(toastId)) dismissNewsId(toastId.slice(NEWS_TOAST_PREFIX.length));
};

let shipped: Promise<NewsItem[]> | undefined;

/**
 * The announcements the build ships (src/content/news.json), newest first, as their own chunk: only a
 * player who has saved a pack, or opens the What's new page, ever asks for it, so the first load doesn't
 * carry it, and nothing is fetched. Asked for once at a time (StrictMode asks twice). A chunk that fails to load, or a file that
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
