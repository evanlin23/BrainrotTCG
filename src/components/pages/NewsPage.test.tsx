// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import shipped from '../../content/news.json';
import { parseNews, type NewsItem } from '../../game/news';
import NewsPage from './NewsPage';

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const show = (items?: readonly NewsItem[]) => act(() => root.render(<NewsPage items={items} />));
const entries = () => [...container.querySelectorAll('.news-entry')];

describe('NewsPage', () => {
  it('lists every shipped entry in order with its date, tag, title, whole summary and no chip', () => {
    show();
    const items = parseNews(shipped);
    expect(entries()).toHaveLength(items.length);
    entries().forEach((entry, index) => {
      expect(entry.querySelector('.news-entry-title')?.textContent).toBe(items[index].title);
      expect(entry.querySelector('.news-entry-summary')?.textContent).toBe(items[index].summary);
      expect(entry.querySelector('time')?.getAttribute('datetime')).toBe(items[index].date);
      expect(entry.querySelector('.news-entry-tag')?.textContent).toBeTruthy();
    });
    expect(container.querySelector('.news-banner')).toBeNull();
  });

  it('shows a full summary, a formatted date, the tag and a link that opens a new tab safely', () => {
    const summary = 'A long summary. '.repeat(20).trim();
    show([
      { id: 'b', title: 'Second', date: '2026-10-25', category: 'event', summary: 'Older.' },
      { id: 'a', title: 'First', date: '2026-10-27', tag: 'Update', summary, link: { text: 'Read the notes', url: 'https://example.invalid/notes' } },
    ]);
    const [second, first] = entries();
    // Given order is kept: the page does not re-sort what it is handed (parseNews does that for the file).
    expect(second.querySelector('.news-entry-title')?.textContent).toBe('Second');
    expect(second.querySelector('.news-entry-tag')?.textContent).toBe('Event');
    expect(second.querySelector('time')?.textContent).toBe('Oct 25, 2026');
    expect(second.querySelector('a')).toBeNull();
    expect(first.querySelector('.news-entry-summary')?.textContent).toBe(summary);
    expect(first.querySelector('.news-entry-tag')?.textContent).toBe('Update');
    const link = first.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://example.invalid/notes');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link.textContent).toContain('Read the notes');
  });

  it('keeps a date it cannot read as it is', () => {
    show([{ id: 'a', title: 'A', date: 'soon', summary: 'Later.' }]);
    expect(container.querySelector('time')?.textContent).toBe('soon');
  });

  it('says so when there is nothing to show', () => {
    show([]);
    expect(entries()).toHaveLength(0);
    expect(container.querySelector('.news-empty')?.textContent).toContain('Nothing new yet');
  });
});

describe('shipped news copy', () => {
  it('speaks to players: no API paths or file names', () => {
    for (const item of parseNews(shipped)) {
      expect(`${item.title} ${item.summary}`).not.toMatch(/\/api\/|\.json|\bAPIs?\b/);
    }
  });
});
