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

export const dismissNewsId = (id: string): boolean => {
  try {
    localStorage.setItem(STORAGE_KEYS.DISMISSED_NEWS, id);
    return true;
  } catch {
    return false;
  }
};

export const isNewsDismissed = (id: string): boolean => {
  return getDismissedNewsId() === id;
};

export const getLatestUnreadNews = (items: readonly NewsItem[]): NewsItem | null => {
  if (items.length === 0) return null;
  const latest = items[0];
  return isNewsDismissed(latest.id) ? null : latest;
};

const NEWS_FETCH_TIMEOUT_MS = 3_000;

export const fetchNews = async (
  base = import.meta.env.BASE_URL ?? '/',
  fetchFn = fetch,
): Promise<NewsItem[] | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NEWS_FETCH_TIMEOUT_MS);
  try {
    const url = `${base.replace(/\/+$/, '')}/news.json`;
    const res = await fetchFn(url, { signal: controller.signal, cache: 'no-cache' });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    return parseNews(json);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};
