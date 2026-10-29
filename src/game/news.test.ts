// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import shipped from '../content/news.json';
import {
  dismissNewsId,
  getDismissedNewsId,
  getLatestUnreadNews,
  isNewsDismissed,
  isValidNewsItem,
  loadNews,
  type NewsItem,
  parseNews,
} from './news';

describe('news data & validation', () => {
  beforeEach(() => {
    localStorage.clear();
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
});
