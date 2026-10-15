// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HallOfFameEntry } from '../../game/hallOfFameList';
import HallOfFamePage from './HallOfFamePage';

const { loadHallOfFame, loadPending } = vi.hoisted(() => ({ loadHallOfFame: vi.fn(), loadPending: vi.fn() }));
vi.mock('../../game/hallOfFameList', () => ({ loadHallOfFame, loadPending }));
// Re-verifying entries mines tickets; these tests only look at loading.
vi.mock('../../game/pulls', () => ({ checkPull: () => new Promise(() => {}) }));

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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  loadHallOfFame.mockReset();
  loadPending.mockReset().mockResolvedValue(undefined);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const status = () => document.querySelector<HTMLElement>('[role="status"]')!;
const retryButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Retry loading leaderboard"]');

describe('Hall of Fame loading', () => {
  it('shows a failure with Retry, and Retry fetches again and shows the results', async () => {
    let settle!: (list: HallOfFameEntry[] | null) => void;
    loadHallOfFame.mockResolvedValueOnce(null).mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));

    await act(async () => root.render(<HallOfFamePage onClose={() => {}} />));
    expect(status().textContent).toBe("Couldn't load the leaderboard. Try again.");
    expect(status().tabIndex).toBe(-1);
    expect(document.activeElement).toBe(status());
    expect(document.body.textContent).not.toContain('Nothing filed here yet');
    expect(retryButton()?.disabled).toBe(false);

    await act(async () => retryButton()!.click());
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
  });

  it('leaves focus alone when the first load succeeds', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage onClose={() => {}} />));
    expect(status().textContent).toBe('Leaderboard loaded.');
    expect(document.activeElement).not.toBe(status());
  });
});
