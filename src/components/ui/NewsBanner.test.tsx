// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NewsBanner from './NewsBanner';
import { dismissNewsId, type NewsItem } from '../../game/news';

const sampleItems: NewsItem[] = [
  {
    id: 'news-1',
    title: 'Open Card API Released',
    date: '2026-10-27',
    category: 'changelog',
    tag: 'Update',
    summary: 'Static JSON endpoints are now available.',
  },
  {
    id: 'news-0',
    title: 'Initial Launch',
    date: '2026-10-20',
    category: 'news',
    tag: 'News',
    summary: 'The game has launched.',
  },
];

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('NewsBanner', () => {
  it('renders the latest unread announcement', () => {
    act(() => root.render(<NewsBanner items={sampleItems} />));
    const banner = container.querySelector('.news-banner');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute('role')).toBe('region');
    expect(banner?.getAttribute('aria-label')).toBe('Announcement');
    expect(banner?.querySelector('.news-banner-tag')?.textContent).toBe('Update');
    expect(banner?.querySelector('.news-banner-title')?.textContent).toBe('Open Card API Released');
    expect(banner?.querySelector('.news-banner-summary')?.textContent).toBe('Static JSON endpoints are now available.');
  });

  it('hides when hidden prop is true', () => {
    act(() => root.render(<NewsBanner items={sampleItems} hidden />));
    expect(container.querySelector('.news-banner')).toBeNull();
  });

  it('hides when the latest announcement has already been dismissed', () => {
    dismissNewsId('news-1');
    act(() => root.render(<NewsBanner items={sampleItems} />));
    expect(container.querySelector('.news-banner')).toBeNull();
  });

  it('dismisses announcement when clicking the dismiss button', () => {
    const onDismiss = vi.fn();
    act(() => root.render(<NewsBanner items={sampleItems} onDismiss={onDismiss} />));

    const dismissBtn = container.querySelector<HTMLButtonElement>('.news-banner-dismiss');
    expect(dismissBtn).not.toBeNull();
    expect(dismissBtn?.getAttribute('aria-label')).toBe('Dismiss announcement');

    act(() => dismissBtn?.click());
    expect(onDismiss).toHaveBeenCalledWith('news-1');
    expect(container.querySelector('.news-banner')).toBeNull();
  });

  it('renders link when provided in the news item', () => {
    const itemsWithLink: NewsItem[] = [
      {
        ...sampleItems[0],
        link: { text: 'View documentation', url: 'https://example.com/docs' },
      },
    ];
    act(() => root.render(<NewsBanner items={itemsWithLink} />));
    const link = container.querySelector<HTMLAnchorElement>('.news-banner-link');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe('View documentation');
    expect(link?.getAttribute('href')).toBe('https://example.com/docs');
  });
});
