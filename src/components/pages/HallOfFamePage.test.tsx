// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HallOfFameEntry } from '../../game/hallOfFameList';
import { HALL_OF_FAME_MIN_MULTIPLIER } from '../../engine';
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
const retryButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Retry loading rankings"]');
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

    await act(async () => root.render(<HallOfFamePage />));
    expect(status().textContent).toBe("Couldn't load the rankings. Try again.");
    expect(status().tabIndex).toBe(-1);
    expect(document.activeElement).toBe(status());
    expect(document.body.textContent).not.toContain('Nothing filed here yet');
    expect(retryButton()?.disabled).toBe(false);

    // A real click focuses the button; the button then goes away on success.
    await act(async () => clickRetry());
    expect(loadHallOfFame).toHaveBeenCalledTimes(2);
    expect(status().textContent).toBe('Loading rankings…');
    expect(retryButton()?.disabled).toBe(true);

    await act(async () => settle([ENTRY]));
    expect(status().textContent).toBe('Rankings loaded.');
    expect(document.activeElement).toBe(status());
    expect(retryButton()).toBeNull();
    expect(document.querySelector('a[aria-label="Number 1: Full House by Alice in Original, score 12345"]')).not.toBeNull();
    expect(loadPending).toHaveBeenCalledTimes(1);
    expect(loadPending.mock.calls[0][0]).toEqual([ENTRY]);
    expect((loadPending.mock.calls[0][2] as AbortSignal).aborted).toBe(false);
  });

  it('shows the failure again when a retry fails, and can retry again', async () => {
    loadHallOfFame.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage />));
    expect(status().textContent).toBe("Couldn't load the rankings. Try again.");

    await act(async () => clickRetry());
    expect(loadHallOfFame).toHaveBeenCalledTimes(2);
    expect(status().textContent).toBe("Couldn't load the rankings. Try again.");
    expect(retryButton()?.disabled).toBe(false);
    expect(document.activeElement).toBe(status());
    expect(loadPending).not.toHaveBeenCalled();

    await act(async () => clickRetry());
    expect(loadHallOfFame).toHaveBeenCalledTimes(3);
    expect(status().textContent).toBe('Rankings loaded.');
    expect(loadPending).toHaveBeenCalledTimes(1);
  });

  it('leaves focus on a tab when the load fails or a retry succeeds', async () => {
    let settle!: (list: HallOfFameEntry[] | null) => void;
    const pendingLoad = () => new Promise<HallOfFameEntry[] | null>((resolve) => { settle = resolve; });
    loadHallOfFame.mockImplementationOnce(pendingLoad).mockImplementationOnce(pendingLoad);
    await act(async () => root.render(<HallOfFamePage />));
    const archiveTab = tab('Archive');

    archiveTab.focus();
    await act(async () => settle(null));
    expect(status().textContent).toBe("Couldn't load the rankings. Try again.");
    expect(document.activeElement).toBe(archiveTab);

    await act(async () => clickRetry());
    archiveTab.focus();
    await act(async () => settle([ENTRY]));
    expect(status().textContent).toBe('Rankings loaded.');
    expect(document.activeElement).toBe(archiveTab);
  });

  it('leaves focus alone when the first load succeeds', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage />));
    expect(status().textContent).toBe('Rankings loaded.');
    expect(document.activeElement).not.toBe(status());
  });

  it('aborts the pending-submissions check when the page closes', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage />));
    expect(loadPending).toHaveBeenCalledTimes(1);
    const signal = loadPending.mock.calls[0][2] as AbortSignal;
    expect(signal.aborted).toBe(false);

    act(() => root.unmount());
    expect(signal.aborted).toBe(true);
  });

  it('stops re-verifying a pull when the page closes, so its ticket stops waiting', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage />));
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
    await act(async () => root.render(<HallOfFamePage />));

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
    await act(async () => root.render(<HallOfFamePage />));
    expect(rows()).toHaveLength(20);
    expect(showMore()).toBeUndefined();
  });
});

describe('Rankings tabs', () => {
  const rows = () => [...document.querySelectorAll<HTMLAnchorElement>('.hof-list .hof-entry')];
  const labels = () => rows().map((a) => a.getAttribute('aria-label'));
  const select = async (label: string) => act(async () => tab(label).click());
  const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();

  beforeEach(() => {
    // Only the clock: promises and timers stay real. Today is 16 October, noon, where the player is.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 16, 12));
  });
  afterEach(() => vi.useRealTimers());

  it('offers All-time, Today and Archive, with All-time first', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage />));
    expect(document.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Rankings lists');
    expect([...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['All-time', 'Today', 'Archive']);
    expect(tab('All-time').getAttribute('aria-selected')).toBe('true');
    expect(labels()).toEqual(['Number 1: Full House by Alice in Original, score 12345']);
  });

  it("ranks today's filed pulls by the player's own date, plus just-submitted ones", async () => {
    const filed = [
      { ...ENTRY, id: 'early', proof: 'early', issue: 1, name: 'Early', score: 2_000, submittedAt: at(16, 0) },
      { ...ENTRY, id: 'yesterday', proof: 'yesterday', issue: 2, name: 'Yesterday', score: 90_000, submittedAt: at(15, 23) },
      { ...ENTRY, id: 'morning', proof: 'morning', issue: 3, name: 'Morning', score: 5_000, submittedAt: at(16, 9) },
    ];
    // Not filed yet: its own time can't be trusted, so it counts as today whatever it says.
    const sent: HallOfFameEntry = { ...ENTRY, id: 'sent', proof: 'sent', issue: -1, name: 'Sent', score: 3_000, pending: true, submittedAt: at(12, 9) };
    loadHallOfFame.mockResolvedValueOnce(filed);
    loadPending.mockImplementationOnce(async (_list: HallOfFameEntry[], onEntry: (e: HallOfFameEntry) => void) => onEntry(sent));
    await act(async () => root.render(<HallOfFamePage />));
    expect(rows()).toHaveLength(4);

    await select('Today');
    expect(tab('Today').getAttribute('aria-selected')).toBe('true');
    expect(labels()).toEqual([
      'Number 1: Full House by Morning in Original, score 5000',
      'Number 2: Full House by Sent in Original, score 3000',
      'Number 3: Full House by Early in Original, score 2000',
    ]);
    expect(rows()[1].textContent).toContain('Just submitted');
    expect(document.querySelector('.hof-panel .hof-note')?.textContent).toContain('filed today (your time)');
  });

  it('says so when nothing came in today', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage />));
    await select('Today');
    expect(rows()).toHaveLength(0);
    expect(document.querySelector('.hof-empty')?.textContent).toContain('Nothing new today yet.');
  });

  it('moves on to the new day when the page stays open past midnight', async () => {
    loadHallOfFame.mockResolvedValueOnce([{ ...ENTRY, submittedAt: at(16, 23) }]);
    await act(async () => root.render(<HallOfFamePage />));
    await select('Today');
    expect(rows()).toHaveLength(1);
    vi.setSystemTime(new Date(2026, 9, 17, 0, 5));
    await select('All-time');
    await select('Today');
    expect(rows()).toHaveLength(0);
  });

  it('starts each list at its first page', async () => {
    const many = Array.from({ length: 30 }, (_, i): HallOfFameEntry => ({ ...ENTRY, id: `p${i}`, proof: `p${i}`, issue: 100 + i, score: 50_000 - i, submittedAt: at(16, 8) }));
    loadHallOfFame.mockResolvedValueOnce(many);
    await act(async () => root.render(<HallOfFamePage />));
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Show more')!.click());
    expect(rows()).toHaveLength(30);
    await select('Today');
    expect(rows()).toHaveLength(20);
  });

  it('keeps world firsts and the hackathon legends in an explained archive', async () => {
    loadHallOfFame.mockResolvedValueOnce([{ ...ENTRY, multiplier: HALL_OF_FAME_MIN_MULTIPLIER }]);
    await act(async () => root.render(<HallOfFamePage />));
    await select('Archive');
    const headings = [...document.querySelectorAll('.hof-panel h2')].map((h) => h.textContent);
    expect(headings).toEqual(['World firsts', 'Hackathon legends']);
    const [firsts, legends] = [...document.querySelectorAll<HTMLElement>('.hof-archive')];
    expect(firsts.getAttribute('aria-labelledby')).toBe(firsts.querySelector('h2')!.id);
    expect(firsts.textContent).toContain('The first verified Full House');
    // A first is dated, not ranked.
    expect(firsts.querySelector('.hof-entry')?.getAttribute('aria-label')).toBe('Full House by Alice in Original, score 12345');
    expect(legends.textContent).toContain('before pulls could be verified');
    expect(legends.querySelectorAll('.hof-legend img')).toHaveLength(3);
  });

  it('shows the legends even when the list fails to load', async () => {
    loadHallOfFame.mockResolvedValueOnce(null);
    await act(async () => root.render(<HallOfFamePage />));
    await select('Archive');
    expect(status().textContent).toBe("Couldn't load the rankings. Try again.");
    expect(retryButton()).not.toBeNull();
    expect(document.querySelectorAll('.hof-legend')).toHaveLength(3);
    expect(document.body.textContent).not.toContain('Nothing filed here yet');
  });
});
