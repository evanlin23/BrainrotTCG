// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HallOfFameEntry } from '../../game/hallOfFameList';
import HallOfFamePage from './HallOfFamePage';

const { loadHallOfFame, loadPending, checkPull } = vi.hoisted(() => ({ loadHallOfFame: vi.fn(), loadPending: vi.fn(), checkPull: vi.fn() }));
vi.mock('../../game/hallOfFameList', () => ({ loadHallOfFame, loadPending }));
// Re-verifying entries mines tickets: here a check only ends when it's stopped.
vi.mock('../../game/pulls', () => ({ checkPull }));

const ENTRY: HallOfFameEntry = {
  id: 'pull-1',
  proof: 'proof-1',
  name: 'Alice',
  fingerprint: 'abcd',
  setId: 'og',
  setName: 'Original',
  hand: 'Full House',
  multiplier: 10,
  score: 12_345,
  submittedAt: '2026-10-01T00:00:00.000Z',
  cards: [],
  issue: 7,
  githubUser: 'alice',
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no ResizeObserver; the page's Sheet only uses it to track overflow.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  loadHallOfFame.mockReset();
  loadPending.mockReset().mockResolvedValue(undefined);
  checkPull.mockReset().mockImplementation((_proof: string, signal?: AbortSignal) =>
    new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('Stopped')))));
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const status = () => document.querySelector<HTMLElement>('[role="status"]')!;
const retryButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Retry loading leaderboard"]');
const tab = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) => el.textContent === label)!;
/** jsdom's click() doesn't focus the button the way a real click does. */
const clickRetry = () => {
  retryButton()!.focus();
  retryButton()!.click();
};

describe('Hall of Fame loading', () => {
  it('shows a failure with Retry, and Retry fetches again and shows the results', async () => {
    let settle!: (list: HallOfFameEntry[] | null) => void;
    loadHallOfFame.mockResolvedValueOnce(null).mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));

    await act(async () => root.render(<HallOfFamePage onClose={() => {}} />));
    // Named like its nav item and loading placeholder, so the dialog keeps one accessible name.
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Rankings');
    expect(status().textContent).toBe("Couldn't load the leaderboard. Try again.");
    expect(status().tabIndex).toBe(-1);
    expect(document.activeElement).toBe(status());
    expect(document.body.textContent).not.toContain('Nothing filed here yet');
    expect(retryButton()?.disabled).toBe(false);

    // A real click focuses the button; the button then goes away on success.
    await act(async () => clickRetry());
    expect(loadHallOfFame).toHaveBeenCalledTimes(2);
    expect(status().textContent).toBe('Loading leaderboard…');
    expect(retryButton()?.disabled).toBe(true);

    await act(async () => settle([ENTRY]));
    expect(status().textContent).toBe('Leaderboard loaded.');
    expect(document.activeElement).toBe(status());
    expect(retryButton()).toBeNull();
    expect(document.querySelector('a[aria-label="Number 1: Full House by Alice in Original, score 12345"]')).not.toBeNull();
    expect(loadPending).toHaveBeenCalledTimes(1);
    expect(loadPending.mock.calls[0][0]).toEqual([ENTRY]);
    expect((loadPending.mock.calls[0][2] as AbortSignal).aborted).toBe(false);
  });

  it('shows the failure again when a retry fails, and can retry again', async () => {
    loadHallOfFame.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage onClose={() => {}} />));
    expect(status().textContent).toBe("Couldn't load the leaderboard. Try again.");

    await act(async () => clickRetry());
    expect(loadHallOfFame).toHaveBeenCalledTimes(2);
    expect(status().textContent).toBe("Couldn't load the leaderboard. Try again.");
    expect(retryButton()?.disabled).toBe(false);
    expect(document.activeElement).toBe(status());
    expect(loadPending).not.toHaveBeenCalled();

    await act(async () => clickRetry());
    expect(loadHallOfFame).toHaveBeenCalledTimes(3);
    expect(status().textContent).toBe('Leaderboard loaded.');
    expect(loadPending).toHaveBeenCalledTimes(1);
  });

  it('leaves focus on a tab when the load fails or a retry succeeds', async () => {
    let settle!: (list: HallOfFameEntry[] | null) => void;
    const pendingLoad = () => new Promise<HallOfFameEntry[] | null>((resolve) => { settle = resolve; });
    loadHallOfFame.mockImplementationOnce(pendingLoad).mockImplementationOnce(pendingLoad);
    await act(async () => root.render(<HallOfFamePage onClose={() => {}} />));
    const firstsTab = tab('World firsts');

    firstsTab.focus();
    await act(async () => settle(null));
    expect(status().textContent).toBe("Couldn't load the leaderboard. Try again.");
    expect(document.activeElement).toBe(firstsTab);

    await act(async () => clickRetry());
    firstsTab.focus();
    await act(async () => settle([ENTRY]));
    expect(status().textContent).toBe('Leaderboard loaded.');
    expect(document.activeElement).toBe(firstsTab);
  });

  it('leaves focus alone when the first load succeeds', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage onClose={() => {}} />));
    expect(status().textContent).toBe('Leaderboard loaded.');
    expect(document.activeElement).not.toBe(status());
  });

  it('aborts the pending-submissions check when the page closes', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage onClose={() => {}} />));
    expect(loadPending).toHaveBeenCalledTimes(1);
    const signal = loadPending.mock.calls[0][2] as AbortSignal;
    expect(signal.aborted).toBe(false);

    act(() => root.unmount());
    expect(signal.aborted).toBe(true);
  });

  it('stops re-verifying a pull when the page closes, so its ticket stops waiting', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage onClose={() => {}} />));
    expect(checkPull).toHaveBeenCalledTimes(1);
    expect(checkPull.mock.calls[0][0]).toBe(ENTRY.proof);
    const signal = checkPull.mock.calls[0][1] as AbortSignal;
    expect(signal.aborted).toBe(false);

    act(() => root.unmount());
    expect(signal.aborted).toBe(true);
  });
});

describe('Rankings paging', () => {
  /** 45 entries, best first: entry n scores lower than entry n - 1. */
  const many = Array.from({ length: 45 }, (_, i): HallOfFameEntry => ({
    ...ENTRY,
    id: `pull-${i}`,
    proof: `proof-${i}`,
    issue: 100 + i,
    score: 50_000 - i,
  }));
  const rows = () => [...document.querySelectorAll<HTMLAnchorElement>('.hof-list .hof-entry')];
  const showMore = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Show more');

  it('shows the first 20 rows, and each Show more adds 20 in the same order until all are shown', async () => {
    loadHallOfFame.mockResolvedValue(many);
    await act(async () => root.render(<HallOfFamePage onClose={() => {}} />));

    expect(rows()).toHaveLength(20);
    expect(rows().map((a) => a.getAttribute('href'))).toEqual(many.slice(0, 20).map((e) => `#/pull/${e.proof}`));
    const button = showMore()!;
    expect(button.type).toBe('button');
    expect(button.classList).toContain('btn');

    await act(async () => button.click());
    expect(rows()).toHaveLength(40);
    expect(rows()[20].getAttribute('aria-label')).toMatch(/^Number 21: /);
    // Keyboard users carry on from the first new row.
    expect(document.activeElement).toBe(rows()[20]);

    await act(async () => showMore()!.click());
    expect(rows().map((a) => a.getAttribute('href'))).toEqual(many.map((e) => `#/pull/${e.proof}`));
    expect(document.activeElement).toBe(rows()[40]);
    expect(showMore()).toBeUndefined();
  });

  it('has no Show more when 20 or fewer pulls are ranked', async () => {
    loadHallOfFame.mockResolvedValue(many.slice(0, 20));
    await act(async () => root.render(<HallOfFamePage onClose={() => {}} />));
    expect(rows()).toHaveLength(20);
    expect(showMore()).toBeUndefined();
  });
});
