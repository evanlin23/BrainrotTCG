// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants/config';
import { useNewsToast } from './useNewsToast';

vi.mock('../game/news', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../game/news')>()),
  loadNews: () => Promise.resolve([{ id: 'news-a', title: 'Open Card API', date: '2026-10-27', summary: 'Something new.' }]),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Host { atRest: boolean; packOpen: boolean; viewing: boolean }
const announce = vi.fn();
const withdraw = vi.fn();
let root: Root;
let container: HTMLElement;

const Probe = (host: Host) => {
  useNewsToast({ ...host, announce, withdraw });
  return null;
};
const render = async (host: Host) => {
  await act(async () => { root.render(<Probe {...host} />); });
  await act(async () => { await Promise.resolve(); });
};
const REST: Host = { atRest: true, packOpen: false, viewing: false };
const OPEN: Host = { ...REST, packOpen: true };

beforeEach(() => {
  localStorage.clear();
  announce.mockClear();
  withdraw.mockClear();
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
});

it('asks for nothing on a page load or after a route change: only a pack put away arms it', async () => {
  await render(REST);
  await render({ ...REST, atRest: false });
  await render(REST);
  expect(announce).not.toHaveBeenCalled();
});

it('announces the latest unread entry once a pack is put away', async () => {
  await render(REST);
  await render(OPEN);
  expect(announce).not.toHaveBeenCalled();
  await render(REST);
  expect(announce).toHaveBeenCalledTimes(1);
  expect(announce.mock.calls[0][0]).toMatchObject({ id: 'news:news-a', kicker: "What's new" });
});

it('takes an unshown toast back out when the next pack starts, and brings it back only after that one is put away', async () => {
  await render(REST);
  await render(OPEN);
  await render(REST);
  expect(announce).toHaveBeenCalledTimes(1);
  withdraw.mockClear();
  await render(OPEN);
  expect(withdraw).toHaveBeenCalled();
  expect(announce).toHaveBeenCalledTimes(1);
  await render(REST);
  expect(announce).toHaveBeenCalledTimes(2);
});

it('does not announce an entry that was read, nor while the What\'s new page is open', async () => {
  localStorage.setItem(STORAGE_KEYS.DISMISSED_NEWS, 'news-a');
  await render(OPEN);
  await render(REST);
  expect(announce).not.toHaveBeenCalled();

  localStorage.clear();
  await render(OPEN);
  await render({ ...REST, atRest: false, viewing: true });
  expect(announce).not.toHaveBeenCalled();
  expect(withdraw).toHaveBeenCalled();
  expect(localStorage.getItem(STORAGE_KEYS.DISMISSED_NEWS)).toBe('news-a');
});
