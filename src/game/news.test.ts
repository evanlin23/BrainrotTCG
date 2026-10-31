// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import shipped from '../content/news.json';
import {
  getLatestUnreadNews,
  isValidNewsItem,
  isNewsToastId,
  markNewsRead,
  newestFirst,
  newsTag,
  newsToast,
  newsToastId,
  type NewsItem,
  parseNews,
  readNewsToasts,
} from './news';

// These keep state for the visit (a dismissal storage refused, the shipped list once loaded), so each
// test loads its own copy of the module (docs/DEVELOPMENT.md, Test isolation).
let dismissNewsId: typeof import('./news').dismissNewsId;
let getDismissedNewsId: typeof import('./news').getDismissedNewsId;
let isNewsDismissed: typeof import('./news').isNewsDismissed;
let loadNews: typeof import('./news').loadNews;

describe('news data & validation', () => {
  beforeEach(async () => {
    localStorage.clear();
    vi.resetModules();
    ({ dismissNewsId, getDismissedNewsId, isNewsDismissed, loadNews } = await import('./news'));
  });

  it('validates compliant news items', () => {
    const valid: NewsItem = {
      id: 'update-1',
      title: 'Update 1',
      date: '2026-10-27',
      summary: 'A new update has shipped.',
      category: 'changelog',
      tag: 'Update',
    };
    expect(isValidNewsItem(valid)).toBe(true);
  });

  it('rejects malformed items', () => {
    expect(isValidNewsItem(null)).toBe(false);
    expect(isValidNewsItem({})).toBe(false);
    expect(isValidNewsItem({ id: '1', title: '', date: '2026-10-27', summary: 'ok' })).toBe(false);
    expect(isValidNewsItem({ id: '1', title: 'test', date: '2026-10-27', summary: 123 })).toBe(false);
    expect(isValidNewsItem({ id: '1', title: 'test', date: '2026-10-27', summary: 'ok', link: 'not-object' })).toBe(false);
  });

  it('parses array of items and filters bad records', () => {
    const raw = [
      { id: '1', title: 'Valid', date: '2026-10-27', summary: 'Good' },
      { id: '2', title: '' }, // invalid
      'not even an object',
    ];
    const parsed = parseNews(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('1');
  });

  it('tracks dismissed news state in localStorage', () => {
    expect(getDismissedNewsId()).toBeNull();
    expect(isNewsDismissed('update-1')).toBe(false);

    dismissNewsId('update-1');
    expect(getDismissedNewsId()).toBe('update-1');
    expect(isNewsDismissed('update-1')).toBe(true);
    expect(isNewsDismissed('update-2')).toBe(false);
    expect(localStorage.getItem(STORAGE_KEYS.DISMISSED_NEWS)).toBe('update-1');
  });

  it('keeps a dismissal storage refused for the rest of the visit', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      expect(dismissNewsId('update-1')).toBe(false);
    } finally {
      setItem.mockRestore();
    }
    expect(getDismissedNewsId()).toBeNull();
    expect(isNewsDismissed('update-1')).toBe(true);
    expect(isNewsDismissed('update-2')).toBe(false);

    expect(dismissNewsId('update-2')).toBe(true);
    expect(isNewsDismissed('update-1')).toBe(false);
    expect(isNewsDismissed('update-2')).toBe(true);
  });

  it('determines latest unread news item', () => {
    const items: NewsItem[] = [
      { id: 'latest', title: 'Latest', date: '2026-10-27', summary: 'Latest update' },
      { id: 'older', title: 'Older', date: '2026-10-25', summary: 'Older update' },
    ];
    expect(getLatestUnreadNews(items)?.id).toBe('latest');

    dismissNewsId('latest');
    expect(getLatestUnreadNews(items)).toBeNull();
  });

  it('ships news that is all valid, newest first, with one id each', async () => {
    const items = await loadNews();
    // Nothing the file holds is dropped as invalid: a typo in it would silently hide an announcement.
    expect(items).toHaveLength(shipped.length);
    expect(items.length).toBeGreaterThan(0);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    const dates = items.map((item) => item.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('puts entries newest first by date, keeping the file\'s order within a day', () => {
    const item = (id: string, date: string): NewsItem => ({ id, title: id, date, summary: id });
    const sorted = parseNews([item('old', '2026-10-01'), item('new-a', '2026-10-27'), item('mid', '2026-10-25'), item('new-b', '2026-10-27')]);
    expect(sorted.map((entry) => entry.id)).toEqual(['new-a', 'new-b', 'mid', 'old']);
    expect(newestFirst([])).toEqual([]);
  });

  it('labels an entry by its tag, else its category, else News', () => {
    const base = { id: 'a', title: 'A', date: '2026-10-27', summary: 'A' };
    expect(newsTag({ ...base, tag: 'Feature', category: 'event' })).toBe('Feature');
    expect(newsTag({ ...base, category: 'changelog' })).toBe('Changelog');
    expect(newsTag({ ...base, category: 'event' })).toBe('Event');
    expect(newsTag(base)).toBe('News');
  });

  it('makes a toast of an entry that opens the page, and reads it back out of the toast ids', () => {
    const entry: NewsItem = { id: 'update-1', title: 'Update 1', date: '2026-10-27', summary: 'What changed.' };
    expect(newsToast(entry)).toEqual({ id: newsToastId('update-1'), kicker: "What's new", name: 'Update 1', description: 'What changed.', opens: 'news' });
    expect(isNewsToastId(newsToastId('update-1'))).toBe(true);
    expect(isNewsToastId('level-2')).toBe(false);
    expect(isNewsToastId('pack-kept-1')).toBe(false);

    readNewsToasts(['level-2', 'pack-kept-1']);
    expect(getDismissedNewsId()).toBeNull();
    readNewsToasts(['level-2', newsToastId('update-1')]);
    expect(isNewsDismissed('update-1')).toBe(true);
  });

  it('reads the newest entry when the page is opened, and nothing when there is none', () => {
    markNewsRead([]);
    expect(getDismissedNewsId()).toBeNull();
    markNewsRead([{ id: 'latest', title: 'L', date: '2026-10-27', summary: 'L' }, { id: 'older', title: 'O', date: '2026-10-25', summary: 'O' }]);
    expect(getDismissedNewsId()).toBe('latest');
  });

  it('shows the toast once per visit even when storage refuses the reading', () => {
    const entry: NewsItem = { id: 'update-1', title: 'Update 1', date: '2026-10-27', summary: 'What changed.' };
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    try {
      readNewsToasts([newsToastId(entry.id)]);
    } finally {
      setItem.mockRestore();
    }
    expect(getLatestUnreadNews([entry])).toBeNull();
  });
});
