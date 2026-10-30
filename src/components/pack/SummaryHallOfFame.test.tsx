// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dailyRank, HALL_OF_FAME_MIN_SCORE, pullId, qualifiesForHallOfFame, wouldJoinHallOfFame, type PackScore } from '../../engine';
import { DEFAULT_SET_ID, getSet } from '../../content/sets';
import { getSetCards } from '../../data/cards';
import { STAGE_CLICK_GUARD_MS, useStageClickGuard } from '../../hooks/useStageClickGuard';
import type { CardWithMeta } from '../cards/Card';
import { loadHallOfFame, loadPending, type HallOfFameEntry } from '../../game/hallOfFameList';
import { publishUntilAccepted } from '../../game/nostrInbox';
import { submitToHallOfFame } from '../../game/share';
import ShareSheet from '../share/ShareSheet';
import SummaryScreen from './PackSummaryUI';
import SummaryHallOfFame from './SummaryHallOfFame';

// PackOpener owns the settle window and hands it down; stand in for it, as it does for a summary just shown.
const PackSummaryUI = (props: Omit<ComponentProps<typeof SummaryScreen>, 'guard'>) => (
  <SummaryScreen {...props} guard={useStageClickGuard()} />
);

// The proof and the list are stand-ins: this checks each state of the line, not the join rules. The
// send goes through the real registry in game/share, with the relays stubbed.
vi.mock('../../game/pulls', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/pulls')>()),
  canShare: vi.fn(() => true),
  proofFor: vi.fn(() => 'proof'),
  pullUrl: vi.fn(() => 'https://example.invalid/#/pull/proof'),
}));
vi.mock('../../engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../engine')>()),
  decodeProof: vi.fn(() => ({})),
  pullId: vi.fn(() => 'pull-1'),
  qualifiesForHallOfFame: vi.fn(() => true),
  wouldJoinHallOfFame: vi.fn(() => true),
  dailyRank: vi.fn((...args: Parameters<typeof import('../../engine').dailyRank>) => realDailyRank(...args)),
}));
vi.mock('../../game/hallOfFameList', () => ({ loadHallOfFame: vi.fn(async () => []), loadPending: vi.fn(async () => true) }));
vi.mock('../../game/nostrInbox', () => ({
  hallOfFameEvent: vi.fn(() => ({})),
  publishUntilAccepted: vi.fn(async () => ({ accepted: {}, all: Promise.resolve([]) })),
}));
vi.mock('../../game/bragImage', () => ({ renderPoster: vi.fn(async () => new Blob(['poster'], { type: 'image/png' })) }));

const { dailyRank: realDailyRank } = await vi.importActual<typeof import('../../engine')>('../../engine');

const score = { points: 100, hand: { name: 'Royal Rot', multiplier: 50 }, score: 5000 } as unknown as PackScore;
const pack = { setId: DEFAULT_SET_ID, setVersion: 1, nonce: 3 };
let root: Root;
let container: HTMLElement;
let pull = 0;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:poster'; }
    static revokeObjectURL() {}
  });
  // Sends are remembered for the page's life, so each test sends its own pull.
  vi.mocked(pullId).mockReturnValue(`pull-${++pull}`);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const render = async (sheet = false) => {
  await act(async () => root.render(
    <>
      <SummaryHallOfFame pack={pack} score={score} />
      {sheet && <ShareSheet target={{ ref: pack, cards: [], score }} onClose={() => {}} />}
    </>,
  ));
  return container.querySelector('.summary-hof');
};
const RULE = `a Full House or better, or a Brainrot Score of ${HALL_OF_FAME_MIN_SCORE.toLocaleString()}+`;
const PUBLIC_NOTICE = 'Your display name and public key become public.';
/** The line as read, one space between its parts (the gaps are CSS), without the public-name notice. */
const line = () =>
  [...(container.querySelector('.summary-hof')?.children ?? [])]
    .filter((el) => !el.classList.contains('summary-hof-public'))
    .map((el) => el.textContent)
    .join(' ');
const notice = () => container.querySelector('.summary-hof .summary-hof-public');
const button = () => container.querySelector<HTMLButtonElement>('.summary-hof button');
const sheetButton = () => document.querySelector<HTMLButtonElement>('.share-hof button');
/** A relay answer the test gives when it wants. */
const holdRelay = () => {
  let accept: (ok: boolean) => void = () => {};
  vi.mocked(publishUntilAccepted).mockReturnValueOnce(new Promise((resolve) => {
    accept = (ok) => resolve({ accepted: ok ? ({} as never) : null, all: Promise.resolve([]) });
  }));
  return (ok: boolean) => accept(ok);
};
/** An empty line that keeps its room, so the cards below don't move. */
const expectPlaceholder = (el: Element | null) => {
  expect(el?.getAttribute('aria-hidden')).toBe('true');
  expect(el?.childElementCount).toBe(0);
};

describe('the Hall of Fame line on the pack summary', () => {
  it('says why there is no Submit for a pull that does not qualify, in the words Rankings uses (#1004)', async () => {
    vi.mocked(qualifiesForHallOfFame).mockReturnValueOnce(false);
    const el = await render();
    expect(el?.textContent).toBe(
      `Doesn't qualify for Rankings, which take ${RULE}. See How Rankings work.`,
    );
    expect(el?.getAttribute('aria-hidden')).toBeNull();
    expect(loadHallOfFame).not.toHaveBeenCalled();
  });

  describe('"How Rankings work" in that note', () => {
    const renderNote = async (onOpenRankingsHelp?: () => void) => {
      vi.mocked(qualifiesForHallOfFame).mockReturnValueOnce(false);
      await act(async () => root.render(<SummaryHallOfFame pack={pack} score={score} onOpenRankingsHelp={onOpenRankingsHelp} />));
      return container.querySelector('.summary-hof')!;
    };

    it('is a button that opens it, and the sentence reads the same', async () => {
      const open = vi.fn();
      const note = await renderNote(open);
      const help = note.querySelector('button')!;
      expect(note.querySelectorAll('button')).toHaveLength(1);
      expect(help.textContent).toBe('How Rankings work');
      expect(help.type).toBe('button');
      expect(note.textContent).toBe(`Doesn't qualify for Rankings, which take ${RULE}. See How Rankings work.`);
      expect(open).not.toHaveBeenCalled();
      act(() => help.click());
      expect(open).toHaveBeenCalledTimes(1);
    });

    it('stays plain text where there is nowhere to go', async () => {
      const note = await renderNote();
      expect(note.querySelector('button')).toBeNull();
      expect(note.textContent).toContain('See How Rankings work.');
    });
  });

  it('says nothing about qualifying for a pull that does', async () => {
    await render();
    expect(container.querySelector('.summary-hof')?.textContent).not.toMatch(/qualif|How Rankings work/);
  });

  it('keeps its room while the list loads', async () => {
    vi.mocked(loadHallOfFame).mockReturnValueOnce(new Promise(() => {}));
    expectPlaceholder(await render());
  });

  it("says why there is no Submit for a pull that qualifies but wouldn't make the list (#1072)", async () => {
    vi.mocked(wouldJoinHallOfFame).mockReturnValue(false);
    try {
      const el = await render();
      expect(el?.textContent).toBe("Qualifies, but wouldn't beat the lowest listed score. See How Rankings work.");
      expect(button()).toBeNull();
      expect(el?.classList.contains('summary-hof--not-listed')).toBe(true);
      expect(el?.getAttribute('aria-hidden')).toBeNull();
    } finally {
      vi.mocked(wouldJoinHallOfFame).mockReturnValue(true);
    }
  });

  describe('"How Rankings work" when a qualifying pull would not make the list', () => {
    const renderFloorNote = async (onOpenRankingsHelp?: () => void) => {
      vi.mocked(wouldJoinHallOfFame).mockReturnValue(false);
      try {
        await act(async () => root.render(<SummaryHallOfFame pack={pack} score={score} onOpenRankingsHelp={onOpenRankingsHelp} />));
        return container.querySelector('.summary-hof')!;
      } finally {
        vi.mocked(wouldJoinHallOfFame).mockReturnValue(true);
      }
    };

    it('is a button that opens it, and the sentence reads the same', async () => {
      const open = vi.fn();
      const note = await renderFloorNote(open);
      const help = note.querySelector('button')!;
      expect(note.querySelectorAll('button')).toHaveLength(1);
      expect(help.textContent).toBe('How Rankings work');
      expect(help.type).toBe('button');
      expect(note.textContent).toBe("Qualifies, but wouldn't beat the lowest listed score. See How Rankings work.");
      expect(open).not.toHaveBeenCalled();
      act(() => help.click());
      expect(open).toHaveBeenCalledTimes(1);
    });

    it('stays plain text where there is nowhere to go', async () => {
      const note = await renderFloorNote();
      expect(note.querySelector('button')).toBeNull();
      expect(note.textContent).toContain('See How Rankings work.');
    });
  });

  it('keeps its room, empty, for a pull already listed', async () => {
    vi.mocked(loadHallOfFame).mockResolvedValueOnce([{ id: 'pull-1' } as HallOfFameEntry]);
    vi.mocked(pullId).mockReturnValue('pull-1');
    expectPlaceholder(await render());
  });

  it("offers one-tap Submit for a pull that makes today's Rankings", async () => {
    await render();
    expect(line()).toBe("🏆 Makes today's Rankings · Submit to Rankings");
    expect(button()?.textContent).toBe('Submit to Rankings');
  });

  it('says the display name and public key become public, read before Submit and kept after it', async () => {
    await render();
    expect(notice()?.textContent).toBe(PUBLIC_NOTICE);
    expect(notice()!.compareDocumentPosition(button()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => button()!.click());
    expect(line()).toBe('🏆 Submitted · #1 today');
    expect(notice()?.textContent).toBe(PUBLIC_NOTICE);
  });

  it("says the all-time Rankings, not today's, for a pull that only makes the all-time list", async () => {
    vi.mocked(dailyRank).mockReturnValue(null);
    try {
      await render();
      expect(line()).toBe('🏆 Makes the all-time Rankings · Submit to Rankings');
      await act(async () => button()!.click());
      expect(line()).toBe('🏆 Submitted · #1 all-time');
    } finally {
      vi.mocked(dailyRank).mockImplementation(realDailyRank);
    }
  });

  it('ranks against the pending sends too, as Rankings does', async () => {
    const today = new Date().toISOString();
    const higher = { id: 'other', setId: DEFAULT_SET_ID, hand: 'Royal Rot', multiplier: 50, score: 9000, submittedAt: today } as HallOfFameEntry;
    vi.mocked(loadPending).mockImplementationOnce(async (_published, onEntry) => { onEntry(higher); return true; });
    await render();
    expect(loadPending).toHaveBeenCalledWith([], expect.any(Function), expect.any(AbortSignal));
    await act(async () => button()!.click());
    expect(line()).toBe('🏆 Submitted · #2 today');
  });

  it('says it is submitting while the first relay has not answered', async () => {
    const answer = holdRelay();
    await render();
    await act(async () => button()!.click());
    expect(line()).toBe('🏆 Submitting…');
    expect(button()).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('.summary-hof'));
    await act(async () => answer(true));
    expect(line()).toBe('🏆 Submitted · #1 today');
  });

  it("uses neutral wording and reads just Submitted when the list couldn't load (#1072)", async () => {
    vi.mocked(loadHallOfFame).mockResolvedValueOnce(null);
    await render();
    expect(line()).toBe('🏆 Qualifies for Rankings · Submit to Rankings');
    await act(async () => button()!.click());
    expect(line()).toBe('🏆 Submitted');
  });

  it('offers Retry when every relay refuses, and a retry can still send it', async () => {
    holdRelay()(false);
    await render();
    await act(async () => button()!.click());
    expect(line()).toBe("🏆 Couldn't submit · Retry");
    vi.mocked(publishUntilAccepted).mockRejectedValueOnce(new Error('offline'));
    await act(async () => button()!.click());
    expect(line()).toBe("🏆 Couldn't submit · Retry");
    await act(async () => button()!.click());
    expect(line()).toBe('🏆 Submitted · #1 today');
  });

  it('reads Submitted for a pull this device already sent', async () => {
    localStorage.setItem('brainrot-hof-submitted-v1', JSON.stringify([`pull-${pull}`]));
    await render();
    expect(line()).toBe('🏆 Submitted');
    expect(button()).toBeNull();
  });
});

describe('one send per pull, however it is sent', () => {
  it('reads Submitted once the share sheet sent it, after the sheet closes', async () => {
    await render(true);
    await act(async () => sheetButton()!.click());
    expect(sheetButton()?.textContent).toBe('Submitted');
    await render(false);
    expect(line()).toBe('🏆 Submitted · #1 today');
    expect(button()).toBeNull();
    expect(publishUntilAccepted).toHaveBeenCalledTimes(1);
  });

  it('shows a send from the line as sending in a sheet opened meanwhile, and never sends twice', async () => {
    const answer = holdRelay();
    await render();
    await act(async () => button()!.click());
    await render(true);
    expect(sheetButton()?.textContent).toBe('Sending…');
    expect(sheetButton()?.disabled).toBe(true);
    // Even a tap that gets through joins the send under way.
    await act(async () => { void submitToHallOfFame('proof', `pull-${pull}`, 5000); });
    await act(async () => answer(true));
    expect(sheetButton()?.textContent).toBe('Submitted');
    expect(line()).toBe('🏆 Submitted · #1 today');
    expect(publishUntilAccepted).toHaveBeenCalledTimes(1);
  });

  it('picks a send back up when the line remounts mid-send', async () => {
    const answer = holdRelay();
    await render();
    await act(async () => button()!.click());
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(line()).toBe('🏆 Submitting…');
    expect(button()).toBeNull();
    await act(async () => answer(true));
    expect(line()).toBe('🏆 Submitted · #1 today');
    expect(publishUntilAccepted).toHaveBeenCalledTimes(1);
  });
});

describe("the Hall of Fame line in the summary's first moments (#627)", () => {
  const set = getSet(DEFAULT_SET_ID, 1)!;
  const cards = getSetCards(set.id).slice(0, 5).map((card, i) => ({
    ...card, uniqueId: i + 1, isRevealed: true, isHolo: false, finish: null,
  }) as CardWithMeta);

  afterEach(() => vi.useRealTimers());

  it('ignores a Submit click until the summary has settled, so a stuck click never publishes the name and key', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<PackSummaryUI openedCards={cards} set={set} onClose={() => {}} pack={pack} />));
    expect(button()?.textContent).toBe('Submit to Rankings');

    await act(async () => { button()!.click(); });
    await act(async () => { vi.advanceTimersByTime(STAGE_CLICK_GUARD_MS - 1); });
    await act(async () => { button()!.click(); });
    expect(publishUntilAccepted).not.toHaveBeenCalled();
    expect(line()).toBe("🏆 Makes today's Rankings · Submit to Rankings");

    await act(async () => { vi.advanceTimersByTime(1); });
    await act(async () => { button()!.click(); });
    expect(publishUntilAccepted).toHaveBeenCalledTimes(1);
    expect(line()).toBe('🏆 Submitted · #1 today');
  });
});
