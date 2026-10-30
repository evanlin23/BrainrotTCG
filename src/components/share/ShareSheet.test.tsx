// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HALL_OF_FAME_MIN_SCORE, pullId, qualifiesForHallOfFame, wouldJoinHallOfFame, type PackScore } from '../../engine';
import { DEFAULT_SET_ID, getSet } from '../../content/sets';
import { getSetCards } from '../../data/cards';
import type { CardWithMeta } from '../cards/Card';
import { revealOrder } from '../../game/reveal';
import { loadHallOfFame, type HallOfFameEntry } from '../../game/hallOfFameList';
import { hallOfFameEvent, publishUntilAccepted } from '../../game/nostrInbox';
import ShareSheet from './ShareSheet';

// The proof and the list are stand-ins: this checks where the Hall of Fame offer sits in the sheet.
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
}));
vi.mock('../../game/hallOfFameList', () => ({ loadHallOfFame: vi.fn(async () => []) }));
vi.mock('../../game/share', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/share')>()),
  bragText: vi.fn(() => 'Look at this pull'),
}));
vi.mock('../../game/nostrInbox', () => ({
  hallOfFameEvent: vi.fn(() => ({})),
  publishUntilAccepted: vi.fn(async () => ({ accepted: {}, all: Promise.resolve([]) })),
}));
vi.mock('../../game/bragImage', () => ({ renderPoster: vi.fn(async () => new Blob(['poster'], { type: 'image/png' })) }));

const score = { points: 100, hand: { name: 'Royal Rot' }, score: 1000 } as unknown as PackScore;
const target = { ref: { setId: DEFAULT_SET_ID, setVersion: 1, nonce: 3 }, cards: [], score };
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

/** True when each element (or selector's element) comes after the one before it in the document. */
const inOrder = (items: (string | Element | undefined)[]) => {
  const els = items.map((item) => (typeof item === 'string' ? document.querySelector(item) : item));
  expect(els.every(Boolean)).toBe(true);
  return els.every((el, i) => i === 0 || !!(els[i - 1]!.compareDocumentPosition(el!) & Node.DOCUMENT_POSITION_FOLLOWING));
};

describe('Hall of Fame in the pack share sheet', () => {
  it('offers the submit with the share buttons, ahead of the poster and the cards', async () => {
    await act(async () => root.render(<ShareSheet target={target} onClose={() => {}} />));
    expect(inOrder(['.share-actions-main', '.share-hof', '.share-preview', '.share-pack-cards'])).toBe(true);
  });

  it('has no GitHub route for the submit: one button, no issue link', async () => {
    await act(async () => root.render(<ShareSheet target={target} onClose={() => {}} />));
    const offer = document.querySelector('.share-hof')!;
    expect(offer.querySelector('a')).toBeNull();
    expect(offer.textContent).not.toMatch(/github/i);
    expect(document.querySelector('a[href*="github.com"]')).toBeNull();
    expect([...offer.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Submit']);
  });

  it('says what becomes public before the submit', async () => {
    await act(async () => root.render(<ShareSheet target={target} onClose={() => {}} />));
    const notice = document.querySelector('.share-hof .share-hof-public')!;
    expect(notice.textContent).toBe('Your display name and public key become public.');
    expect(inOrder([notice, '.share-hof button'])).toBe(true);
  });

  it('puts the already-listed note in the same place', async () => {
    vi.mocked(loadHallOfFame).mockResolvedValueOnce([{ id: `pull-${pull}` } as HallOfFameEntry]);
    await act(async () => root.render(<ShareSheet target={target} onClose={() => {}} />));
    expect(document.querySelector('.share-hof')).toBeNull();
    const listed = [...document.querySelectorAll('.share-note')].find((el) => el.textContent?.includes('in Rankings'));
    expect(inOrder(['.share-actions-main', listed, '.share-preview', '.share-pack-cards'])).toBe(true);
  });

  it('says why there is no Submit for a pull that does not qualify, in the words Rankings uses (#1004)', async () => {
    vi.mocked(qualifiesForHallOfFame).mockReturnValue(false);
    await act(async () => root.render(<ShareSheet target={target} onClose={() => {}} />));
    vi.mocked(qualifiesForHallOfFame).mockReturnValue(true);
    expect(document.querySelector('.share-hof')).toBeNull();
    const why = [...document.querySelectorAll('.share-note')].find((el) => el.textContent?.includes('qualify'))!;
    expect(why.textContent?.trim()).toBe(
      `Doesn't qualify for Rankings, which take a Full House or better, or a Brainrot Score of ${HALL_OF_FAME_MIN_SCORE.toLocaleString()}+. See How Rankings work.`,
    );
    expect(inOrder(['.share-actions-main', why, '.share-preview', '.share-pack-cards'])).toBe(true);
    expect(loadHallOfFame).not.toHaveBeenCalled();
  });

  describe('"How Rankings work" in that note', () => {
    const renderNote = async (onClose: () => void, onOpenRankingsHelp?: () => void) => {
      vi.mocked(qualifiesForHallOfFame).mockReturnValue(false);
      await act(async () => root.render(<ShareSheet target={target} onClose={onClose} onOpenRankingsHelp={onOpenRankingsHelp} />));
      vi.mocked(qualifiesForHallOfFame).mockReturnValue(true);
      return [...document.querySelectorAll('.share-note')].find((el) => el.textContent?.includes('qualify'))!;
    };

    it('is a button that closes the sheet and opens it, with the sentence unchanged', async () => {
      const calls: string[] = [];
      const note = await renderNote(() => calls.push('close'), () => calls.push('open'));
      const help = note.querySelector('button')!;
      expect(help.textContent).toBe('How Rankings work');
      expect(note.textContent?.trim()).toBe(
        `Doesn't qualify for Rankings, which take a Full House or better, or a Brainrot Score of ${HALL_OF_FAME_MIN_SCORE.toLocaleString()}+. See How Rankings work.`,
      );
      expect(calls).toEqual([]);
      act(() => help.click());
      expect(calls).toEqual(['close', 'open']);
    });

    it('stays plain text where there is nowhere to go', async () => {
      const note = await renderNote(() => {});
      expect(note.querySelector('button')).toBeNull();
    });
  });

  it('offers Submit, with no qualifying note, for a pull that qualifies', async () => {
    await act(async () => root.render(<ShareSheet target={target} onClose={() => {}} />));
    expect(document.querySelector('.share-hof button')).not.toBeNull();
    expect(document.querySelector('.share-hof strong')?.textContent).toBe('This makes Rankings');
    expect([...document.querySelectorAll('.share-note')].some((el) => /qualif|How Rankings work/.test(el.textContent ?? ''))).toBe(false);
  });

  it("says why there is no Submit for a pull that qualifies but wouldn't make the list (#1072)", async () => {
    vi.mocked(wouldJoinHallOfFame).mockReturnValue(false);
    try {
      await act(async () => root.render(<ShareSheet target={target} onClose={() => {}} />));
      expect(document.querySelector('.share-hof')).toBeNull();
      const why = [...document.querySelectorAll('.share-note')].find((el) => el.textContent?.includes('lowest listed score'))!;
      expect(why.textContent?.trim()).toBe(
        "Qualifies for Rankings, but wouldn't beat the lowest listed score. See How Rankings work.",
      );
      expect(inOrder(['.share-actions-main', why, '.share-preview', '.share-pack-cards'])).toBe(true);
    } finally {
      vi.mocked(wouldJoinHallOfFame).mockReturnValue(true);
    }
  });

  describe('"How Rankings work" when a qualifying pull would not make the list', () => {
    const renderFloorNote = async (onClose: () => void, onOpenRankingsHelp?: () => void) => {
      vi.mocked(wouldJoinHallOfFame).mockReturnValue(false);
      try {
        await act(async () => root.render(<ShareSheet target={target} onClose={onClose} onOpenRankingsHelp={onOpenRankingsHelp} />));
        return [...document.querySelectorAll('.share-note')].find((el) => el.textContent?.includes('lowest listed score'))!;
      } finally {
        vi.mocked(wouldJoinHallOfFame).mockReturnValue(true);
      }
    };

    it('is a button that closes the sheet and opens it, with the sentence unchanged', async () => {
      const calls: string[] = [];
      const note = await renderFloorNote(() => calls.push('close'), () => calls.push('open'));
      const help = note.querySelector('button')!;
      expect(help.textContent).toBe('How Rankings work');
      expect(note.textContent?.trim()).toBe(
        "Qualifies for Rankings, but wouldn't beat the lowest listed score. See How Rankings work.",
      );
      expect(calls).toEqual([]);
      act(() => help.click());
      expect(calls).toEqual(['close', 'open']);
    });

    it('stays plain text where there is nowhere to go', async () => {
      const note = await renderFloorNote(() => {});
      expect(note.querySelector('button')).toBeNull();
    });
  });

  it("uses neutral headline when the list couldn't load (#1072)", async () => {
    vi.mocked(loadHallOfFame).mockResolvedValueOnce(null);
    await act(async () => root.render(<ShareSheet target={target} onClose={() => {}} />));
    const offer = document.querySelector('.share-hof')!;
    expect(offer.querySelector('strong')?.textContent).toBe('Qualifies for Rankings');
    expect(offer.querySelector('button')?.textContent).toBe('Submit');
  });

  it('keeps the already-listed note, not the qualifying one, for a pull in Rankings', async () => {
    vi.mocked(loadHallOfFame).mockResolvedValueOnce([{ id: `pull-${pull}` } as HallOfFameEntry]);
    await act(async () => root.render(<ShareSheet target={target} onClose={() => {}} />));
    expect([...document.querySelectorAll('.share-note')].some((el) => /qualif/.test(el.textContent ?? ''))).toBe(false);
  });

  const clickSubmit = async () => {
    await act(async () => root.render(<ShareSheet target={target} onClose={() => {}} />));
    const button = [...document.querySelectorAll<HTMLButtonElement>('.share-hof button')].find((b) => b.textContent === 'Submit')!;
    await act(async () => button.click());
    return button;
  };

  it('shows the pull as submitted once a relay takes it, without a relay count', async () => {
    const button = await clickSubmit();
    expect(publishUntilAccepted).toHaveBeenCalledTimes(1);
    expect(vi.mocked(hallOfFameEvent).mock.calls[0][3]).toBe(1000); // the score hint the inbox can skip on
    expect(button.textContent).toBe('Submitted');
    expect(button.disabled).toBe(true);
    const status = document.querySelector('.share-hof [role="status"]')!.textContent!;
    expect(status).toContain('It shows in Rankings now');
    expect(status).not.toMatch(/relays?\b/);
  });

  it('offers a retry when no relay takes it', async () => {
    vi.mocked(publishUntilAccepted).mockResolvedValueOnce({ accepted: null, all: Promise.resolve([]) });
    const button = await clickSubmit();
    expect(button.textContent).toBe('Submit');
    expect(button.disabled).toBe(false);
    const status = document.querySelector('.share-hof [role="status"]')!.textContent!;
    expect(status).toContain("Couldn't reach any relay. Try again.");
    expect(status).not.toMatch(/github/i);
    expect(document.querySelector('.share-hof a')).toBeNull();
  });

  it('counts today’s top (UTC) when deciding whether to offer the submit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T23:30:00-05:00'));
    try {
      await act(async () => root.render(<ShareSheet target={target} onClose={() => {}} />));
    } finally {
      vi.useRealTimers();
    }
    expect(vi.mocked(wouldJoinHallOfFame)).toHaveBeenLastCalledWith(expect.objectContaining({ id: `pull-${pull}` }), [], '2026-10-17');
  });
});

describe('cards in this pack', () => {
  it('puts the individual-card gallery behind a named control, apart from the whole-pack actions', async () => {
    await act(async () => root.render(<ShareSheet target={target} onClose={() => {}} />));
    const disclosure = document.querySelector<HTMLDetailsElement>('details.share-disclosure:has(.share-pack-cards)')!;
    const summary = disclosure.querySelector('summary')!;
    expect(summary.textContent).toBe('Share an individual card');
    expect(disclosure.open).toBe(false);
    expect(disclosure.querySelector('section[aria-label="Cards in this pack"]')).not.toBeNull();
    expect(disclosure.textContent).toContain('The controls above share the whole pack.');
    // The poster stays a plain preview, not a tap target.
    expect(document.querySelector('.share-preview')!.closest('button, a, [role="button"]')).toBeNull();
    act(() => summary.click());
    expect(disclosure.open).toBe(true);
  });

  it('shows a reopened pack in the order it was revealed, best last, not the order it was stored', async () => {
    const set = getSet(DEFAULT_SET_ID, 1)!;
    // Stored (engine) order: a Gold, a Holo, then plain cards, so revealing moves the extras to the end.
    const stored = getSetCards(set.id).slice(0, 5).map((card, i) => ({
      ...card, rarity: 'COMMON', uniqueId: i + 1, isRevealed: true, isHolo: i === 1, finish: i === 0 ? 'GOLD' : null,
    }) as CardWithMeta);
    await act(async () => root.render(<ShareSheet target={{ ...target, cards: stored }} onClose={() => {}} />));
    const shown = [...document.querySelectorAll('.share-pack-cards .pack-viewer-card-grid')].map((el) => el.getAttribute('aria-label')!.replace(/ \(.*\)$/, ''));
    expect(shown).toEqual(revealOrder(stored).map((card) => card.name));
    expect(shown).not.toEqual(stored.map((card) => card.name));
  });
});
