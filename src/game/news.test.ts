// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import {
  dismissNewsId,
  fetchNews,
  getDismissedNewsId,
  getLatestUnreadNews,
  isNewsDismissed,
  isValidNewsItem,
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

  it('determines latest unread news item', () => {
    const items: NewsItem[] = [
      { id: 'latest', title: 'Latest', date: '2026-10-27', summary: 'Latest update' },
      { id: 'older', title: 'Older', date: '2026-10-25', summary: 'Older update' },
    ];
    expect(getLatestUnreadNews(items)?.id).toBe('latest');

    dismissNewsId('latest');
    expect(getLatestUnreadNews(items)).toBeNull();
  });

  it('fetches news with timeout and returns null on failure', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: 'fetched-1', title: 'News', date: '2026-10-27', summary: 'Hello' }],
    });

    const result = await fetchNews('/', fakeFetch as unknown as typeof fetch);
    expect(result).toHaveLength(1);
    expect(result![0].id).toBe('fetched-1');

    const failingFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const failedResult = await fetchNews('/', failingFetch as unknown as typeof fetch);
    expect(failedResult).toBeNull();
  });
});
