// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HallOfFameEntry } from '../../game/hallOfFameList';
import type { PastDay, PublishedRankings } from '../../game/publishedRankings';
import { archivedPull, HALL_OF_FAME_MIN_MULTIPLIER, HALL_OF_FAME_MIN_SCORE, HALL_OF_FAME_TOP } from '../../engine';
import HallOfFamePage from './HallOfFamePage';

const { loadHallOfFame, loadPending, checkPull } = vi.hoisted(() => ({ loadHallOfFame: vi.fn(), loadPending: vi.fn(), checkPull: vi.fn() }));
vi.mock('../../game/hallOfFameList', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../game/hallOfFameList')>()), loadHallOfFame, loadPending }));
const { loadPublishedRankings, loadPastMonth } = vi.hoisted(() => ({ loadPublishedRankings: vi.fn(), loadPastMonth: vi.fn() }));
vi.mock('../../game/publishedRankings', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../game/publishedRankings')>()), loadPublishedRankings, loadPastMonth }));
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
  // No rankings.json unless a test serves one, as on a site from before the archives.
  loadPublishedRankings.mockReset().mockResolvedValue(null);
  loadPastMonth.mockReset().mockResolvedValue(null);
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
// The row's accessible name without the trailing source ("…, via relay"), which has its own test.
const labels = () => rows().map((a) => a.getAttribute('aria-label')?.replace(/, via (?:relay|GitHub)$/, ''));
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
    expect(retryButton()).toBeNull();
    expect(document.querySelector(".hof-skeleton")).not.toBeNull();

    await act(async () => settle([ENTRY]));
    expect(status().textContent).toBe('Rankings loaded.');
    expect(document.activeElement).toBe(status());
    expect(retryButton()).toBeNull();
    await select('All-time');
    expect(document.querySelector('a[aria-label="Number 1: Full House by Alice in Original, score 12345, via GitHub"]')).not.toBeNull();
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

  it("says the live feed is down when every relay failed, with Retry, instead of an empty board", async () => {
    loadHallOfFame.mockResolvedValue([]);
    loadPending.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await act(async () => root.render(<HallOfFamePage />));

    expect(status().textContent).toBe("Couldn't reach the live feed, so pulls sent recently may be missing. Try again.");
    expect(status().classList.contains('sr-only')).toBe(false);
    expect(status().parentElement?.classList.contains('hof-load-state--quiet')).toBe(false);
    const empty = () => document.querySelector('.hof-empty')?.textContent;
    expect(empty()).toContain('No filed pulls today that we can see.');
    expect(empty()).not.toMatch(/No pulls filed today yet|could be first/);
    await select('All-time');
    expect(empty()).toContain('Nothing filed here that we can see.');
    expect(empty()).not.toMatch(/Nothing filed here yet|could be first/);

    // Retry reloads everything; this time a relay answers, so the board is honestly empty.
    await act(async () => clickRetry());
    expect(loadHallOfFame).toHaveBeenCalledTimes(2);
    expect(status().textContent).toBe('Rankings loaded.');
    expect(retryButton()).toBeNull();
    expect(empty()).toContain('Nothing filed here yet.');
  });

  it('keeps the published pulls and the plain empty-board copy when the relays answered', async () => {
    loadHallOfFame.mockResolvedValueOnce([]);
    loadPending.mockResolvedValueOnce(true);
    await act(async () => root.render(<HallOfFamePage />));
    expect(status().textContent).toBe('Rankings loaded.');
    expect(status().classList.contains('sr-only')).toBe(true);
    expect(retryButton()).toBeNull();
    expect(document.querySelector('.hof-empty')?.textContent).toContain('No pulls filed today yet.');
    expect(document.querySelector('.hof-empty')?.textContent).toContain('Yours could be first.');
  });

  it('still lists the published pulls when the relays are down', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    loadPending.mockResolvedValueOnce(false);
    await act(async () => root.render(<HallOfFamePage />));
    await select('All-time');
    expect(status().textContent).toContain("Couldn't reach the live feed");
    expect(labels()).toEqual(['Number 1: Full House by Alice in Original, score 12345']);
    expect(document.querySelector('.hof-empty')).toBeNull();
  });

  describe('while the live relays are still being asked', () => {
    const empty = () => document.querySelector('.hof-empty')?.textContent;
    const OFFLINE = "Couldn't reach the live feed, so pulls sent recently may be missing. Try again.";
    const CHECKING = 'Checking for new packs…';
    /** Every text the status ever held, so a premature "Rankings loaded." can't slip past between two checks. */
    const watchStatus = () => {
      const seen: string[] = [];
      const record = () => { const text = status().textContent!; if (seen[seen.length - 1] !== text) seen.push(text); };
      record();
      new MutationObserver(record).observe(status(), { childList: true, characterData: true, subtree: true });
      return seen;
    };

    it('shows a checking line, not the empty board or "Rankings loaded.", until the relays answer', async () => {
      let answer!: (reached: boolean) => void;
      loadHallOfFame.mockResolvedValueOnce([]);
      loadPending.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
      await act(async () => root.render(<HallOfFamePage />));
      const seen = watchStatus();

      expect(status().textContent).toBe(CHECKING);
      expect(status().classList.contains('sr-only')).toBe(false);
      expect(retryButton()).toBeNull();
      expect(empty()).toBeUndefined();
      expect(document.body.textContent).not.toMatch(/No pulls filed today yet|Nothing filed here yet|could be first/);
      await select('All-time');
      expect(empty()).toBeUndefined();

      await act(async () => answer(false));
      expect(status().textContent).toBe(OFFLINE);
      expect(retryButton()?.disabled).toBe(false);
      expect(empty()).toContain('Nothing filed here that we can see.');
      expect(seen).not.toContain('Rankings loaded.');
    });

    it('announces "Rankings loaded." and the plain empty board once the relays answer', async () => {
      let answer!: (reached: boolean) => void;
      loadHallOfFame.mockResolvedValueOnce([]);
      loadPending.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
      await act(async () => root.render(<HallOfFamePage />));
      const seen = watchStatus();
      expect(empty()).toBeUndefined();

      await act(async () => answer(true));
      expect(status().textContent).toBe('Rankings loaded.');
      expect(status().classList.contains('sr-only')).toBe(true);
      expect(retryButton()).toBeNull();
      expect(empty()).toContain('No pulls filed today yet.');
      expect(seen).toEqual([CHECKING, 'Rankings loaded.']);
    });

    it('does the same again after Retry', async () => {
      let answer!: (reached: boolean) => void;
      loadHallOfFame.mockResolvedValue([]);
      loadPending.mockResolvedValueOnce(false).mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
      await act(async () => root.render(<HallOfFamePage />));
      expect(status().textContent).toBe(OFFLINE);

      await act(async () => clickRetry());
      const seen = watchStatus();
      expect(loadHallOfFame).toHaveBeenCalledTimes(2);
      expect(status().textContent).toBe(CHECKING);
      expect(retryButton()).toBeNull();
      expect(empty()).toBeUndefined();
      expect(document.body.textContent).not.toMatch(/No pulls filed today yet|could be first/);

      await act(async () => answer(true));
      expect(status().textContent).toBe('Rankings loaded.');
      expect(empty()).toContain('No pulls filed today yet.');
      expect(seen).not.toContain(OFFLINE);
    });

    it('lists the published pulls straight away, without waiting for the relays', async () => {
      loadHallOfFame.mockResolvedValueOnce([ENTRY]);
      loadPending.mockImplementationOnce(() => new Promise<boolean>(() => {}));
      await act(async () => root.render(<HallOfFamePage />));
      await select('All-time');
      expect(labels()).toEqual(['Number 1: Full House by Alice in Original, score 12345']);
      expect(status().textContent).toBe(CHECKING);
      expect(document.body.textContent).not.toContain('Loading rankings');
      expect(retryButton()).toBeNull();
    });

    it('says "Loading rankings…" only until the published list arrives', async () => {
      loadHallOfFame.mockImplementationOnce(() => new Promise(() => {}));
      await act(async () => root.render(<HallOfFamePage />));
      expect(status().textContent).toBe('Loading rankings…');
      expect(status().classList.contains('sr-only')).toBe(false);
      expect(status().parentElement?.classList.contains('hof-load-state--quiet')).toBe(false);
      expect(retryButton()).toBeNull();
      expect(loadPending).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain('Checking for');
    });

    it('shows skeleton rows, not an empty board or Retry, while the first load and check run', async () => {
      let settle!: (list: HallOfFameEntry[]) => void;
      loadHallOfFame.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
      loadPending.mockImplementationOnce(() => new Promise<boolean>(() => {}));
      await act(async () => root.render(<HallOfFamePage />));
      const skeleton = () => document.querySelector('.hof-skeleton');
      expect(skeleton()?.getAttribute('aria-hidden')).toBe('true');
      expect(skeleton()?.querySelectorAll('.hof-skeleton-row').length).toBe(3);
      expect(document.querySelector('.hof-empty')).toBeNull();
      expect(retryButton()).toBeNull();

      // The list arrived but is empty and the live check is still running: still placeholders, not "nothing here".
      await act(async () => settle([]));
      expect(status().textContent).toBe(CHECKING);
      expect(skeleton()).not.toBeNull();
      expect(document.querySelector('.hof-empty')).toBeNull();
      expect(retryButton()).toBeNull();
    });

    it('drops the skeleton as soon as there are rows to show', async () => {
      loadHallOfFame.mockResolvedValueOnce([ENTRY]);
      loadPending.mockImplementationOnce(() => new Promise<boolean>(() => {}));
      await act(async () => root.render(<HallOfFamePage />));
      await select('All-time');
      expect(rows()).toHaveLength(1);
      expect(document.querySelector('.hof-skeleton')).toBeNull();
    });

    it('puts the skeleton after the Today note, so the note does not move when rows arrive', async () => {
      loadHallOfFame.mockResolvedValueOnce([]);
      loadPending.mockImplementationOnce(() => new Promise<boolean>(() => {}));
      await act(async () => root.render(<HallOfFamePage />));
      const note = document.querySelector('.hof-note')!;
      const skeleton = document.querySelector('.hof-skeleton')!;
      expect(note.compareDocumentPosition(skeleton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('has no skeleton on a healthy empty board', async () => {
      loadHallOfFame.mockResolvedValueOnce([]);
      await act(async () => root.render(<HallOfFamePage />));
      expect(document.querySelector('.hof-empty')).not.toBeNull();
      expect(document.querySelector('.hof-skeleton')).toBeNull();
    });

    it('has no skeleton when the live feed is unavailable', async () => {
      loadHallOfFame.mockResolvedValueOnce([]);
      loadPending.mockResolvedValueOnce(false);
      await act(async () => root.render(<HallOfFamePage />));
      expect(retryButton()).not.toBeNull();
      expect(document.querySelector('.hof-skeleton')).toBeNull();
    });

    it('shows Retry after a failed load, and no skeleton', async () => {
      loadHallOfFame.mockResolvedValueOnce(null);
      await act(async () => root.render(<HallOfFamePage />));
      expect(retryButton()).not.toBeNull();
      expect(document.querySelector('.hof-skeleton')).toBeNull();
    });

    it('shows the checking line as one quiet line, once the published list is loaded', async () => {
      loadHallOfFame.mockResolvedValueOnce([ENTRY]);
      loadPending.mockImplementationOnce(() => new Promise<boolean>(() => {}));
      await act(async () => root.render(<HallOfFamePage />));
      expect(status().textContent).toBe(CHECKING);
      expect(status().getAttribute('role')).toBe('status');
      expect(status().parentElement?.classList.contains('hof-load-state--quiet')).toBe(true);
      expect(document.body.textContent).not.toContain('Loading rankings');
    });

    describe('past the check deadline', () => {
      beforeEach(() => {
        // Noon the day after ENTRY was filed: today's board is empty, and ENTRY is yesterday's best.
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(Date.parse('2026-10-02T12:00:00.000Z'));
      });

      it('stops saying it is checking after 15 seconds, and lets the empty board and yesterday\'s best show', async () => {
        loadHallOfFame.mockResolvedValueOnce([ENTRY]);
        loadPending.mockImplementationOnce(() => new Promise<boolean>(() => {}));
        await act(async () => root.render(<HallOfFamePage />));
        expect(status().textContent).toBe(CHECKING);
        expect(empty()).toBeUndefined();
        expect(document.querySelector('.hof-yesterday')).toBeNull();

        await act(async () => { vi.advanceTimersByTime(14_999); });
        expect(status().textContent).toBe(CHECKING);
        expect(empty()).toBeUndefined();

        await act(async () => { vi.advanceTimersByTime(1); });
        expect(status().textContent).toBe('Rankings loaded.');
        expect(status().classList.contains('sr-only')).toBe(true);
        expect(document.body.textContent).not.toContain('Checking for');
        expect(retryButton()).toBeNull();
        expect(empty()).toContain('No pulls filed today yet.');
        expect(document.querySelector('.hof-yesterday')?.textContent).toContain("Yesterday's best");
      });

      it('carries the check on: later entries still join the lists, and a relay-less end still says so', async () => {
        let add!: (entry: HallOfFameEntry) => void;
        let answer!: (reached: boolean) => void;
        loadHallOfFame.mockResolvedValueOnce([ENTRY]);
        loadPending.mockImplementationOnce((_list: HallOfFameEntry[], onEntry: (entry: HallOfFameEntry) => void) => {
          add = onEntry;
          return new Promise<boolean>((resolve) => { answer = resolve; });
        });
        await act(async () => root.render(<HallOfFamePage />));
        await act(async () => { vi.advanceTimersByTime(15_000); });
        expect((loadPending.mock.calls[0][2] as AbortSignal).aborted).toBe(false);
        expect(status().textContent).toBe('Rankings loaded.');
        expect(empty()).toContain('No pulls filed today yet.');

        await act(async () => add({ ...ENTRY, id: 'pull-2', proof: 'proof-2', name: 'Bob', issue: 8, score: 20_000, submittedAt: '2026-10-02T10:00:00.000Z' }));
        expect(labels()).toEqual(['Number 1: Full House by Bob in Original, score 20000']);
        expect(empty()).toBeUndefined();
        expect(status().textContent).toBe('Rankings loaded.');

        // The relays were never reached after all: the live-feed message and Retry appear then.
        await act(async () => answer(false));
        expect(status().textContent).toBe(OFFLINE);
        expect(status().classList.contains('sr-only')).toBe(false);
        expect(retryButton()?.disabled).toBe(false);
        expect(labels()).toHaveLength(1);
      });

      it('changes nothing when the relays answer late, having been reached', async () => {
        let answer!: (reached: boolean) => void;
        loadHallOfFame.mockResolvedValueOnce([ENTRY]);
        loadPending.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
        await act(async () => root.render(<HallOfFamePage />));
        await act(async () => { vi.advanceTimersByTime(15_000); });
        await act(async () => answer(true));
        expect(status().textContent).toBe('Rankings loaded.');
        expect(retryButton()).toBeNull();
        expect(empty()).toContain('No pulls filed today yet.');
      });

      it('clears the deadline when the relays answer first', async () => {
        let answer!: (reached: boolean) => void;
        loadHallOfFame.mockResolvedValueOnce([ENTRY]);
        loadPending.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
        await act(async () => root.render(<HallOfFamePage />));
        const whileChecking = vi.getTimerCount();
        await act(async () => answer(true));
        expect(vi.getTimerCount()).toBe(whileChecking - 1);
        expect(status().textContent).toBe('Rankings loaded.');
      });

      it('clears the deadline when the page closes', async () => {
        loadHallOfFame.mockResolvedValueOnce([ENTRY]);
        loadPending.mockImplementationOnce(() => new Promise<boolean>(() => {}));
        await act(async () => root.render(<HallOfFamePage />));
        expect(vi.getTimerCount()).toBeGreaterThan(0);
        act(() => root.unmount());
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    it('treats a check that fails outright (its code never loaded) as the relays being down', async () => {
      loadHallOfFame.mockResolvedValue([]);
      loadPending.mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module')).mockResolvedValueOnce(true);
      await act(async () => root.render(<HallOfFamePage />));
      expect(status().textContent).toBe(OFFLINE);
      expect(status().classList.contains('sr-only')).toBe(false);
      expect(retryButton()?.disabled).toBe(false);
      expect(empty()).toContain('No filed pulls today that we can see.');
      expect(empty()).not.toMatch(/No pulls filed today yet|could be first/);

      await act(async () => clickRetry());
      expect(status().textContent).toBe('Rankings loaded.');
      expect(retryButton()).toBeNull();
      expect(empty()).toContain('No pulls filed today yet.');
    });
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
    expect(document.querySelector('.hof-panel .hof-note')?.textContent).not.toContain('re-derived');
    expect(document.body.textContent).not.toMatch(/Checking|Failed|re-checked on your device/);
  });

  it("shows a blocked or blank display name as Someone, beside its fingerprint", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(ENTRY.submittedAt) + 3_600_000);
    loadHallOfFame.mockResolvedValueOnce([{ ...ENTRY, name: 'xXfuckXx' }, { ...ENTRY, id: 'pull-2', proof: 'proof-2', name: '  ', issue: 8, score: 1_000 }]);
    await act(async () => root.render(<HallOfFamePage />));
    expect([...document.querySelectorAll('.hof-who')].map((el) => el.textContent)).toEqual(['Someone #abcd', 'Someone #abcd']);
    expect(labels()[0]).toBe('Number 1: Full House by Someone in Original, score 12345');
    expect(document.body.textContent).not.toMatch(/fuck/i);
  });
});

describe('How Rankings work', () => {
  const how = () => document.querySelector<HTMLDetailsElement>('details.hof-how');
  const stateSetups: Record<string, () => void> = {
    loading: () => loadHallOfFame.mockImplementationOnce(() => new Promise(() => {})),
    'failed load': () => loadHallOfFame.mockResolvedValueOnce(null),
    'feed unavailable': () => { loadHallOfFame.mockResolvedValueOnce([]); loadPending.mockResolvedValueOnce(false); },
    'healthy empty': () => loadHallOfFame.mockResolvedValueOnce([]),
    populated: () => loadHallOfFame.mockResolvedValueOnce([ENTRY]),
  };

  it.each(Object.keys(stateSetups))('explains eligibility and explicit submission in the %s state', async (state) => {
    stateSetups[state]();
    await act(async () => root.render(<HallOfFamePage />));
    const text = how()!.textContent!;
    expect(how()!.querySelector('summary')?.textContent).toBe('How Rankings work');
    expect(text).toContain(`a Full House or better, or a Brainrot Score of ${HALL_OF_FAME_MIN_SCORE.toLocaleString()}+`);
    expect(text).toContain('Nothing is filed automatically');
    expect(text).toMatch(/Opening a pack, or copying or sharing a link, does not enter you/);
    expect(text).toContain('results screen or Share sheet');
    expect(text).toContain('Submit is missing if the pull does not qualify, is already listed, was opened under another key or would not beat the lowest score on the lists');
    expect(text).toContain(`ranks the best ${HALL_OF_FAME_TOP} pulls`);
    expect(text).toContain('re-derived from its proof when filed, and newer ones on this device');
    expect(text).toContain('usually filed within about an hour');
    expect(text).toContain('00:00 UTC');
    expect(text).toContain('If the list could not load, or was out of date when you submitted, a pull that does not beat the lowest score is turned away');
    expect(text).toContain('display name and public key public');
    expect(text).toContain('Submitting is not a rank');
    expect(text).toContain('Hall of Fame');
    expect(how()!.open).toBe(false);
  });

  it('keeps the explanation on both tabs', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage />));
    await select('All-time');
    expect(how()).not.toBeNull();
    expect(how()!.closest('[role="tabpanel"]')).toBeNull();
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
    // loadPending stamps a relay submission with the time it was loaded; only this device's own is `mine`.
    const sent: HallOfFameEntry = { ...pull('Sent', 3_000, at(16, 12), -1), pending: true, mine: true };
    const others: HallOfFameEntry = { ...pull('Stranger', 4_000, at(16, 12), -2), pending: true };
    loadHallOfFame.mockResolvedValueOnce(filed);
    loadPending.mockImplementationOnce(async (_list: HallOfFameEntry[], onEntry: (e: HallOfFameEntry) => void) => {
      onEntry(sent);
      onEntry(others);
      return true;
    });
    await act(async () => root.render(<HallOfFamePage />));

    expect(labels()).toEqual([
      'Number 1: Full House by Morning in Original, score 5000',
      'Number 2: Full House by Stranger in Original, score 4000',
      'Number 3: Full House by Sent in Original, score 3000',
      'Number 4: Full House by Early in Original, score 2000',
    ]);
    // Only the viewer's own submission says "Just submitted"; someone else's newer pull is just a row.
    expect(rows().map((row) => row.textContent?.includes('Just submitted'))).toEqual([false, false, true, false]);
    expect(yesterdaySection()).toBeNull();
    const note = document.querySelector('.hof-panel .hof-note')?.textContent;
    const reset = new Date(Date.UTC(2026, 9, 17)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    expect(note).toContain(`Resets at 00:00 UTC (${reset} your time).`);
    expect(note).not.toContain('re-derived');

    await select('All-time');
    expect(rows()).toHaveLength(6);
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
    expect(empty()).toContain(`Pull a Full House or better (or a Brainrot Score of ${HALL_OF_FAME_MIN_SCORE.toLocaleString()}+), share it, and submit it from the share sheet.`);

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

  it('says where each entry came from on its muted line, and nothing for an unknown source', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(ENTRY.submittedAt) + 3_600_000);
    loadHallOfFame.mockResolvedValueOnce([
      ENTRY,
      { ...ENTRY, id: 'pull-2', proof: 'proof-2', issue: 8, score: 5_000, githubUser: 'nostr' },
      { ...ENTRY, id: 'pull-3', proof: 'proof-3', issue: 9, score: 1_000, githubUser: 'unknown' },
    ]);
    await act(async () => root.render(<HallOfFamePage />));
    expect([...document.querySelectorAll('.hof-meta')].map((el) => el.textContent)).toEqual(['Original · via GitHub', 'Original · via relay', 'Original']);
    expect(rows().map((a) => a.getAttribute('aria-label'))).toEqual([
      'Number 1: Full House by Alice in Original, score 12345, via GitHub',
      'Number 2: Full House by Alice in Original, score 5000, via relay',
      'Number 3: Full House by Alice in Original, score 1000',
    ]);
    expect(container.querySelector('.hof-entry a')).toBeNull();
  });
});

describe('Past days and the last update', () => {
  const RANKINGS: PublishedRankings = { generatedAt: '2026-10-16T12:04:00.000Z', openFrom: '2026-10-15', months: ['2026-10', '2026-09'] };
  const archived = (n: number, score: number, day: string, name = `Player ${n}`, setId = 'genesis') =>
    archivedPull({ id: `pull-${n}`, issue: 100 + n, setId, hand: 'Full House', score, name, submittedAt: `${day}T09:00:00Z` });
  const OCTOBER: PastDay[] = [
    { day: '2026-10-14', entries: [archived(1, 9_000, '2026-10-14'), archived(2, 8_000, '2026-10-14', '', 'no-such-set')] },
    { day: '2026-10-01', entries: [archived(3, 7_000, '2026-10-01')] },
  ];
  const SEPTEMBER: PastDay[] = [{ day: '2026-09-30', entries: [archived(4, 6_000, '2026-09-30')] }];

  const opener = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Past days');
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const open = async () => {
    opener()!.focus();
    await act(async () => opener()!.click());
  };
  const picker = (label: string) => {
    const el = [...dialog()!.querySelectorAll('label')].find((l) => l.textContent === label);
    return el ? document.getElementById(el.htmlFor) as HTMLSelectElement : null;
  };
  const pick = async (label: string, value: string) =>
    act(async () => {
      const select = picker(label)!;
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  const pastRows = () => [...dialog()!.querySelectorAll<HTMLAnchorElement>('.hof-list .hof-entry')];
  const pastStatus = () => dialog()!.querySelector<HTMLElement>('[role="status"]')!;
  const updated = () => document.querySelector<HTMLElement>('.hof-updated');
  const utcText = (iso: string) =>
    `${new Date(iso).toLocaleString(undefined, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })} UTC`;

  it("says when the lists were last updated, in rankings.json's own time and not this device's", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // The device's clock is far from the build's: the line doesn't move with it.
    vi.setSystemTime(Date.UTC(2031, 0, 1));
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    loadPublishedRankings.mockResolvedValue(RANKINGS);
    await act(async () => root.render(<HallOfFamePage />));
    const time = updated()!.querySelector('time')!;
    expect(time.dateTime).toBe('2026-10-16T12:04:00.000Z');
    expect(updated()!.textContent).toBe(`Lists last updated ${utcText(RANKINGS.generatedAt)}`);
    expect(updated()!.textContent).toMatch(/2026.*UTC$/);
    expect(updated()!.textContent).not.toMatch(/ago|2031/);
  });

  it('shows no time when rankings.json is missing or malformed, and the lists as before', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage />));
    expect(loadPublishedRankings).toHaveBeenCalledTimes(1);
    expect(updated()).toBeNull();
    await select('All-time');
    expect(rows()).toHaveLength(1);
    expect(opener()?.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it("opens the newest closed day of the newest month, and moves between days and months", async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    loadPublishedRankings.mockResolvedValue(RANKINGS);
    loadPastMonth.mockImplementation((_: PublishedRankings, month: string) => Promise.resolve(month === '2026-10' ? OCTOBER : SEPTEMBER));
    await act(async () => root.render(<HallOfFamePage />));
    expect(loadPastMonth).not.toHaveBeenCalled();
    await open();
    const sheet = dialog()!;
    expect(document.getElementById(sheet.getAttribute('aria-labelledby')!)?.textContent).toBe('Past days');
    expect(loadPastMonth).toHaveBeenCalledWith(RANKINGS, '2026-10');
    expect([...picker('Month')!.options].map((o) => o.value)).toEqual(['2026-10', '2026-09']);
    expect([...picker('Day')!.options].map((o) => o.value)).toEqual(['2026-10-14', '2026-10-01']);
    expect(picker('Day')!.value).toBe('2026-10-14');
    expect(pastRows().map((a) => a.getAttribute('aria-label'))).toEqual([
      'Number 1: Full House by Player 1 in Genesis, score 9000, issue 101 on GitHub',
      // A blank name reads as Someone; a set this build doesn't have shows its id.
      'Number 2: Full House by Someone in no-such-set, score 8000, issue 102 on GitHub',
    ]);
    // No proof is archived: each row opens the issue that holds it.
    expect(pastRows()[0].getAttribute('href')).toBe('https://github.com/evanlin23/BrainrotTCG/issues/101');
    expect(pastRows()[0].target).toBe('_blank');
    expect(pastRows()[0].rel).toBe('noopener noreferrer');
    expect(sheet.textContent).toContain("A pull removed since is left out, and its place isn't refilled.");
    // The archive's rows stay in the sheet: the Today and All-time lists don't take them.
    expect(rows().filter((a) => !sheet.contains(a))).toHaveLength(0);

    await pick('Day', '2026-10-01');
    expect(pastRows().map((a) => a.getAttribute('href'))).toEqual(['https://github.com/evanlin23/BrainrotTCG/issues/103']);
    expect(pastStatus().textContent).toContain(': 1 pull.');

    await pick('Month', '2026-09');
    expect(loadPastMonth).toHaveBeenLastCalledWith(RANKINGS, '2026-09');
    expect([...picker('Day')!.options].map((o) => o.value)).toEqual(['2026-09-30']);
    expect(pastRows().map((a) => a.getAttribute('href'))).toEqual(['https://github.com/evanlin23/BrainrotTCG/issues/104']);

    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener());
  });

  it('says quietly that there is no archive when rankings.json is missing or malformed', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    await act(async () => root.render(<HallOfFamePage />));
    await open();
    expect(pastStatus().textContent).toBe("Past days aren't available right now.");
    expect(picker('Month')).toBeNull();
    expect(dialog()!.querySelector('.hof-list')).toBeNull();
    expect(loadPastMonth).not.toHaveBeenCalled();
  });

  it("says quietly when a month's archive is missing or malformed, and still offers the other months", async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    loadPublishedRankings.mockResolvedValue(RANKINGS);
    loadPastMonth.mockImplementation((_: PublishedRankings, month: string) => Promise.resolve(month === '2026-10' ? null : SEPTEMBER));
    await act(async () => root.render(<HallOfFamePage />));
    await open();
    expect(pastStatus().textContent).toBe("This month's past days aren't available right now.");
    expect(picker('Day')).toBeNull();
    expect(dialog()!.querySelector('.hof-list')).toBeNull();
    await pick('Month', '2026-09');
    expect(pastRows()).toHaveLength(1);
  });

  it('says when nothing has closed yet, or a month kept no day', async () => {
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    loadPublishedRankings.mockResolvedValue({ ...RANKINGS, months: [] });
    await act(async () => root.render(<HallOfFamePage />));
    await open();
    expect(pastStatus().textContent).toBe('No past days yet.');
    expect(picker('Month')).toBeNull();
    act(() => root.unmount());

    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    loadPublishedRankings.mockResolvedValue(RANKINGS);
    loadPastMonth.mockResolvedValue([]);
    root = createRoot(container);
    await act(async () => root.render(<HallOfFamePage />));
    await open();
    expect(pastStatus().textContent).toBe('No past days for this month.');
    expect(picker('Month')).not.toBeNull();
  });

  it('says it is loading until rankings.json and the month arrive', async () => {
    let settleRankings!: (r: PublishedRankings | null) => void;
    let settleMonth!: (days: PastDay[] | null) => void;
    loadHallOfFame.mockResolvedValueOnce([ENTRY]);
    loadPublishedRankings.mockImplementation(() => new Promise((resolve) => { settleRankings = resolve; }));
    loadPastMonth.mockImplementation(() => new Promise((resolve) => { settleMonth = resolve; }));
    await act(async () => root.render(<HallOfFamePage />));
    await open();
    expect(pastStatus().textContent).toBe('Loading past days…');
    expect(updated()).toBeNull();
    await act(async () => settleRankings(RANKINGS));
    expect(updated()).not.toBeNull();
    expect(pastStatus().textContent).toBe('Loading past days…');
    await act(async () => settleMonth(OCTOBER));
    expect(pastRows()).toHaveLength(2);
  });
});
