// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HallOfFameEntry } from '../../game/hallOfFameList';
import { HALL_OF_FAME_MIN_MULTIPLIER } from '../../engine';
import HallOfFamePage from './HallOfFamePage';

const { loadHallOfFame, loadPending, checkPull } = vi.hoisted(() => ({ loadHallOfFame: vi.fn(), loadPending: vi.fn(), checkPull: vi.fn() }));
vi.mock('../../game/hallOfFameList', () => ({ loadHallOfFame, loadPending }));
// Re-deriving a pull mines its ticket. The page must never do that for published entries.
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
  checkPull.mockReset().mockResolvedValue({ ok: true });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const status = () => document.querySelector<HTMLElement>('[role="status"]')!;
const retryButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Retry loading rankings"]');
const tab = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) => el.textContent === label)!;
const select = async (label: string) => act(async () => tab(label).click());
const rows = () => [...document.querySelectorAll<HTMLAnchorElement>('.hof-list .hof-entry')];
const labels = () => rows().map((a) => a.getAttribute('aria-label'));
const showMore = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Show more');
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
    await select('All-time');
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
    const allTimeTab = tab('All-time');

    allTimeTab.focus();
    await act(async () => settle(null));
    expect(status().textContent).toBe("Couldn't load the rankings. Try again.");
    expect(document.activeElement).toBe(allTimeTab);

    await act(async () => clickRetry());
    allTimeTab.focus();
    await act(async () => settle([ENTRY]));
    expect(status().textContent).toBe('Rankings loaded.');
    expect(document.activeElement).toBe(allTimeTab);
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

  it("doesn't re-derive published pulls: no ticket is mined, and each row links to its proof instead", async () => {
    // The day these pulls were filed, so both lists show them.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(ENTRY.submittedAt) + 3_600_000);
    const list = Array.from({ length: 25 }, (_, i): HallOfFameEntry => ({ ...ENTRY, id: `pull-${i}`, proof: `proof-${i}`, issue: 100 + i, score: 50_000 - i }));
    loadHallOfFame.mockResolvedValueOnce(list);
    await act(async () => root.render(<HallOfFamePage />));
    await act(async () => showMore()!.click());
    expect(rows()).toHaveLength(25);
    await select('All-time');
    await act(async () => showMore()!.click());
    expect(rows()).toHaveLength(25);

    expect(checkPull).not.toHaveBeenCalled();
    expect(rows().map((a) => a.getAttribute('href'))).toEqual(list.map((e) => `#/pull/${e.proof}`));
    expect(document.querySelector('.hof-panel .hof-note')?.textContent).toContain('Filed pulls were re-derived from their proofs when they were filed, and “Just submitted” ones on this device. Open one to check it yourself.');
    expect(document.body.textContent).not.toMatch(/Checking|Failed|re-checked on your device/);
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
  it('shows the first 20 rows, and each Show more adds 20 in the same order until all are shown', async () => {
    loadHallOfFame.mockResolvedValue(many);
    await act(async () => root.render(<HallOfFamePage />));
    await select('All-time');

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
    await select('All-time');
    expect(rows()).toHaveLength(20);
    expect(showMore()).toBeUndefined();
  });
});

describe('Rankings tabs', () => {
  /** A time on a day of October 2026, in UTC. */
  const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString();
  const pull = (id: string, score: number, submittedAt: string, issue: number): HallOfFameEntry => ({ ...ENTRY, id, proof: id, name: id, issue, score, submittedAt });
  const empty = () => document.querySelector('.hof-panel .hof-empty')?.textContent ?? '';
  const yesterdaySection = () => document.querySelector<HTMLElement>('.hof-yesterday');

  beforeEach(() => {
    // Only the clock: promises and timers stay real. It is noon UTC on 16 October.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 16, 12));
  });

  it('offers Today then All-time, with Today selected', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage />));
    expect(document.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Rankings lists');
    expect([...document.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['Today', 'All-time']);
    expect(tab('Today').getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(tab('Today').id);
    expect(rows()).toHaveLength(0);

    await select('All-time');
    expect(tab('All-time').getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(tab('All-time').id);
    expect(labels()).toEqual(['Number 1: Full House by Alice in Original, score 12345']);
    expect(document.querySelector('.hof-panel .hof-note')?.textContent).toContain('The top 100 by Brainrot Score.');

    await select('Today');
    expect(rows()).toHaveLength(0);
  });

  it("ranks the current UTC day's filed pulls, plus just-submitted ones", async () => {
    const filed = [
      pull('Early', 2_000, at(16, 0), 1),
      pull('LastNight', 90_000, '2026-10-15T23:59:59.999Z', 2),
      pull('Morning', 5_000, at(16, 9), 3),
      // 00:30 on the 16th in UTC+2 is still the 15th in UTC.
      pull('Offset', 80_000, '2026-10-16T00:30:00.000+02:00', 4),
    ];
    // loadPending stamps a relay submission with the time it was loaded.
    const sent: HallOfFameEntry = { ...pull('Sent', 3_000, at(16, 12), -1), pending: true };
    loadHallOfFame.mockResolvedValueOnce(filed);
    loadPending.mockImplementationOnce(async (_list: HallOfFameEntry[], onEntry: (e: HallOfFameEntry) => void) => onEntry(sent));
    await act(async () => root.render(<HallOfFamePage />));

    expect(labels()).toEqual([
      'Number 1: Full House by Morning in Original, score 5000',
      'Number 2: Full House by Sent in Original, score 3000',
      'Number 3: Full House by Early in Original, score 2000',
    ]);
    expect(rows()[1].textContent).toContain('Just submitted');
    expect(yesterdaySection()).toBeNull();
    const note = document.querySelector('.hof-panel .hof-note')?.textContent;
    const reset = new Date(Date.UTC(2026, 9, 17)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    expect(note).toContain(`Resets at 00:00 UTC (${reset} your time).`);
    expect(note).toContain('Filed pulls were re-derived from their proofs when they were filed, and “Just submitted” ones on this device. Open one to check it yourself.');

    await select('All-time');
    expect(rows()).toHaveLength(5);
  });

  it('ranks at most the best 50 of the day', async () => {
    const many = Array.from({ length: 60 }, (_, i) => pull(`p${i}`, 50_000 - i, at(16, 8), 100 + i));
    loadHallOfFame.mockResolvedValueOnce(many);
    await act(async () => root.render(<HallOfFamePage />));
    await act(async () => showMore()!.click());
    await act(async () => showMore()!.click());
    expect(rows().map((a) => a.getAttribute('href'))).toEqual(many.slice(0, 50).map((e) => `#/pull/${e.proof}`));
    expect(showMore()).toBeUndefined();
  });

  it("says so when nothing came in today, and shows up to 3 of yesterday's best", async () => {
    loadHallOfFame.mockResolvedValueOnce([
      ENTRY,
      pull('Third', 3_000, at(15, 1), 1),
      pull('Best', 9_000, at(15, 23, 59), 2),
      pull('Fourth', 1_000, at(15, 2), 3),
      pull('Second', 5_000, at(15, 0), 4),
      pull('TwoDaysAgo', 99_000, at(14, 12), 5),
    ]);
    await act(async () => root.render(<HallOfFamePage />));
    expect(empty()).toContain('No pulls filed today yet.');
    expect(empty()).toContain('submit it from the share sheet');

    const section = yesterdaySection()!;
    const heading = section.querySelector('h2')!;
    expect(heading.textContent).toBe("Yesterday's best");
    expect(section.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(labels()).toEqual([
      'Number 1: Full House by Best in Original, score 9000',
      'Number 2: Full House by Second in Original, score 5000',
      'Number 3: Full House by Third in Original, score 3000',
    ]);
    expect(showMore()).toBeUndefined();
  });

  it('shows only the empty state when yesterday had nothing either', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage />));
    expect(empty()).toContain('No pulls filed today yet.');
    expect(yesterdaySection()).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it('moves on to the new day at 00:00 UTC while the page stays open', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(Date.UTC(2026, 9, 16, 23, 59, 59));
    loadHallOfFame.mockResolvedValueOnce([pull('Late', 4_000, at(16, 23), 1)]);
    await act(async () => root.render(<HallOfFamePage />));
    expect(labels()).toEqual(['Number 1: Full House by Late in Original, score 4000']);
    expect(yesterdaySection()).toBeNull();

    act(() => vi.advanceTimersByTime(999));
    expect(yesterdaySection()).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(empty()).toContain('No pulls filed today yet.');
    expect(yesterdaySection()?.textContent).toContain('Late');
    const reset = new Date(Date.UTC(2026, 9, 18)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    expect(document.querySelector('.hof-panel .hof-note')?.textContent).toContain(`(${reset} your time)`);
  });

  it('starts each list at its first page', async () => {
    const many = Array.from({ length: 30 }, (_, i) => pull(`p${i}`, 50_000 - i, at(16, 8), 100 + i));
    loadHallOfFame.mockResolvedValueOnce(many);
    await act(async () => root.render(<HallOfFamePage />));
    await act(async () => showMore()!.click());
    expect(rows()).toHaveLength(30);
    await select('All-time');
    expect(rows()).toHaveLength(20);
    await act(async () => showMore()!.click());
    await select('Today');
    expect(rows()).toHaveLength(20);
  });

  it('has no world firsts and no archive', async () => {
    loadHallOfFame.mockResolvedValueOnce([{ ...ENTRY, multiplier: HALL_OF_FAME_MIN_MULTIPLIER }]);
    await act(async () => root.render(<HallOfFamePage />));
    for (const label of ['Today', 'All-time']) {
      await select(label);
      expect(document.body.textContent).not.toMatch(/World firsts|Archive|The first verified/);
    }
    expect(tab('Archive')).toBeUndefined();
    expect(document.querySelectorAll('.hof-panel h2')).toHaveLength(0);
  });
});

describe('Where it started', () => {
  const opener = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Where it started');
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  /** jsdom's click() doesn't focus the button the way a real click does. */
  const open = async () => {
    opener()!.focus();
    await act(async () => opener()!.click());
  };

  it('opens the hackathon legends in a sheet, explained, and closes back to its button', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage />));
    expect(opener()?.type).toBe('button');
    expect(opener()?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(dialog()).toBeNull();
    expect(document.querySelectorAll('.hof-legend')).toHaveLength(0);

    await open();
    const sheet = dialog()!;
    expect(document.getElementById(sheet.getAttribute('aria-labelledby')!)?.textContent).toBe('Where it started');
    expect(sheet.textContent).toContain("Screenshots from the hackathon, before pulls could be verified, so they aren't ranked.");
    expect([...sheet.querySelectorAll<HTMLImageElement>('.hof-legend img')].map((img) => img.alt)).toEqual([
      "Adi/frail_banana's 4 of a Kind",
      "Daniel/dandandoo's Full House",
      "TehSquid's Full House",
    ]);
    // Not ranked: the legends never join a list.
    expect(document.querySelector('.hof-panel .hof-legend')).toBeNull();

    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener());

    await open();
    await act(async () => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener());
  });

  it('is there even when the list fails to load', async () => {
    loadHallOfFame.mockResolvedValueOnce(null);
    await act(async () => root.render(<HallOfFamePage />));
    expect(status().textContent).toBe("Couldn't load the rankings. Try again.");
    expect(retryButton()).not.toBeNull();
    await open();
    expect(dialog()?.querySelectorAll('.hof-legend')).toHaveLength(3);
    expect(document.body.textContent).not.toContain('Nothing filed here yet');
  });
});
