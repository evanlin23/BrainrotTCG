// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BestHighlights from './BestHighlights';
import { STORAGE_KEYS } from '../../constants';
import { getSet } from '../../content/sets';
import { scoreCards } from '../../data/cards';
import { cardPoints, type PulledCard } from '../../engine';
import { mergeBestCards, resetBestCards, type BestCandidate } from '../../game/bestCards';
import type { BestCardState, BestPackState, BestPackStats, CheckOptions } from '../../game/bestSources';
import { toPulled } from '../../game/cardCode';
import { getPlayer, PLAYER_STORAGE_KEY } from '../../game/player';
import { toCardsWithMeta } from '../../game/pulls';

// Finding each source is real (Stats, the Best cards list and the player in jsdom's storage); only
// the engine checks are stubbed, so each test decides when and how each one settles.
const { checkBestPack, checkBestCard } = vi.hoisted(() => ({ checkBestPack: vi.fn(), checkBestCard: vi.fn() }));
vi.mock('../../game/bestSources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/bestSources')>()),
  checkBestPack,
  checkBestCard,
}));

const SET = getSet('right-now', 2)!;
const ME = '22'.repeat(32);
const OTHER = '11'.repeat(32);
const points = (c: PulledCard) => cardPoints(c.rarity, c.isHolo, c.finish, c.misprint);
const byPoints = [...SET.cards].sort((a, b) => cardPoints(b.rarity, false, null, false) - cardPoints(a.rarity, false, null, false));
const TOP = byPoints[0];
const WEAK = byPoints[byPoints.length - 1];

/** Pack A (ticket 3) scores more; pack B (ticket 5) holds the stronger single card, so the highlights differ. */
const PACK_A = toPulled(Array(SET.packSize).fill({ id: WEAK.id, holo: false }), SET)!;
const PACK_B = toPulled([{ id: WEAK.id, holo: false }, { id: TOP.id, holo: true }, ...Array(SET.packSize - 2).fill({ id: byPoints[3].id, holo: false })], SET)!;
const engineCards = (pulled: PulledCard[]) => toCardsWithMeta(pulled, SET).map((c) => ({ ...c, isRevealed: true }));

const setPlayer = (secretKey: string) =>
  localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify({ secretKey, name: 'Me', nextNonce: 6, createdAt: 1 }));
const statsFor = (key: string, kept = 999): BestPackStats => ({
  highestPackRef: { setId: SET.id, setVersion: SET.version, nonce: 3, publicKeyHex: key },
  highestPackCards: engineCards(PACK_A),
  // A kept score the engine doesn't give: it must never show as verified.
  highestPackFlexValue: kept,
});
const candidate = (nonce: number, cards: PulledCard[]): BestCandidate => ({ setId: SET.id, setVersion: SET.version, nonce, openedAt: nonce, cards });
const seedBestCards = () => mergeBestCards(getPlayer().publicKeyHex, [candidate(3, PACK_A), candidate(5, PACK_B)], () => 6);

/** A check that settles when the test says, recording the options it was given. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const verifiedPack = (source: unknown): BestPackState => {
  const cards = engineCards(PACK_A);
  return { status: 'available', source: source as never, verified: { cards, score: scoreCards(cards) } };
};
const verifiedCard = (source: { slot: number }): BestCardState => {
  const pulled = PACK_B[source.slot];
  return { status: 'available', source: source as never, verified: { card: engineCards([pulled])[0], pulled, points: points(pulled) } };
};

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  localStorage.clear();
  resetBestCards();
  setPlayer(ME);
  checkBestPack.mockReset().mockImplementation((source) => Promise.resolve(verifiedPack(source)));
  checkBestCard.mockReset().mockImplementation((source) => Promise.resolve(verifiedCard(source)));
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const onSharePack = vi.fn();
const render = async (stats: BestPackStats = statsFor(getPlayer().publicKeyHex), expecting = false) => {
  await act(async () => root.render(<BestHighlights stats={stats} refreshKey="a" expecting={expecting} onSharePack={onSharePack} />));
};
const highlight = (name: string) =>
  [...container.querySelectorAll('section.profile-highlight')].find((s) => s.querySelector('h2')?.textContent === name)!;
const text = (name: string) => highlight(name)?.textContent ?? '';
const verified = (name: string) => highlight(name).querySelector('.profile-verified') !== null;

describe('both highlights', () => {
  it('shows Best pack A and Best card from pack B, each verified with the engine’s cards and score', async () => {
    seedBestCards();
    await render();
    expect(verified('Best pack')).toBe(true);
    expect(verified('Best card')).toBe(true);
    expect(highlight('Best pack').querySelector('.profile-verified')?.getAttribute('aria-hidden')).toBe('true');
    expect(highlight('Best card').querySelector('.profile-verified')?.getAttribute('aria-hidden')).toBe('true');
    const score = scoreCards(engineCards(PACK_A)).score;
    expect(text('Best pack')).toContain(score.toLocaleString());
    expect(text('Best pack')).toContain('ticket #3');
    // The kept score isn't the engine's: only the engine's is shown.
    expect(text('Best pack')).not.toContain('999');
    expect(text('Best card')).toContain(TOP.name);
    expect(text('Best card')).toContain('ticket #5');
    expect(text('Best card')).toContain(points(PACK_B[1]).toLocaleString());
    // Each was checked once, as its own source.
    expect(checkBestPack).toHaveBeenCalledTimes(1);
    expect(checkBestCard).toHaveBeenCalledTimes(1);
    expect(checkBestCard.mock.calls[0][0]).toMatchObject({ ref: { nonce: 5, publicKeyHex: getPlayer().publicKeyHex }, slot: 1 });
    expect(container.textContent).toContain('It covers that pack only');
  });

  it('shares the pack with its full-key reference and the engine’s cards, and opens the card with its pack', async () => {
    seedBestCards();
    await render();
    act(() => highlight('Best pack').querySelector<HTMLButtonElement>('button.pull-row')!.click());
    const checked = (await checkBestPack.mock.results[0].value) as BestPackState;
    if (checked.status !== 'available') throw new Error('unreachable');
    // The engine's cards, never the kept ones.
    expect(onSharePack).toHaveBeenCalledWith(
      { setId: SET.id, setVersion: SET.version, nonce: 3, publicKeyHex: getPlayer().publicKeyHex },
      checked.verified.cards,
    );
    expect(onSharePack.mock.calls[0][1]).toBe(checked.verified.cards);
    act(() => highlight('Best card').querySelector<HTMLButtonElement>('button.best-card-row')!.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute('aria-label') ?? dialog?.textContent).toContain(TOP.name);
    expect(dialog?.querySelector('button')).not.toBeNull();
  });
});

describe('states', () => {
  it('shows the engine’s points for the Best card, never the cached ones from its source', async () => {
    seedBestCards();
    const enginePoints = points(PACK_B[1]);
    const cached = enginePoints + 12345;
    // The source (and its cached points) disagree with what the engine opens.
    checkBestCard.mockImplementation((source: { slot: number }) => Promise.resolve(verifiedCard({ ...source, points: cached } as never)));
    await render();
    const shown = highlight('Best card').querySelector('.pull-row-score')?.textContent ?? '';
    expect(shown).toContain(enginePoints.toLocaleString());
    expect(shown).not.toContain(cached.toLocaleString());
  });

  it('keeps only the state text in the live region, never the row or its buttons', async () => {
    seedBestCards();
    const pack = deferred<BestPackState>();
    checkBestPack.mockReturnValueOnce(pack.promise);
    checkBestCard.mockImplementationOnce((source) => Promise.resolve({ status: 'failed', source, reason: 'error' }));
    await render();
    const live = (name: string) => [...highlight(name).querySelectorAll('[role="status"]')].map((r) => r.textContent);
    expect(live('Best pack')).toEqual(['Checking your best pack against its ticket…']);
    expect(live('Best card')).toEqual(["Couldn't check your best card just now."]);
    // The retry button sits beside the live region, not in it.
    expect(highlight('Best card').querySelector('[role="status"] button')).toBeNull();
    expect(highlight('Best card').querySelector('button')?.textContent).toBe('Try again');

    await act(async () => pack.resolve(verifiedPack(checkBestPack.mock.calls[0][0])));
    expect(live('Best pack')).toEqual(['Verified: your best pack.']);
    expect(highlight('Best pack').querySelector('.pull-row')).not.toBeNull();
    expect(highlight('Best pack').querySelector('[role="status"] .pull-row, [role="status"] button')).toBeNull();
    // One live region per highlight, so two settling at once never read a whole row.
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(2);
  });

  it('shows checking, never the kept cards or score, until each check settles on its own', async () => {
    seedBestCards();
    const pack = deferred<BestPackState>();
    const card = deferred<BestCardState>();
    checkBestPack.mockReturnValue(pack.promise);
    checkBestCard.mockReturnValue(card.promise);
    await render();
    expect(text('Best pack')).toContain('Checking your best pack against its ticket');
    expect(text('Best card')).toContain('Checking your best card against its ticket');
    expect(container.querySelector('.profile-verified')).toBeNull();
    expect(container.textContent).not.toContain('999');
    // Only a held place for each row (same markup, so the page does not move when the real row arrives).
    const held = [...container.querySelectorAll('.pull-row')];
    expect(held).toHaveLength(2);
    for (const row of held) {
      expect(row.classList.contains('profile-highlight-pending')).toBe(true);
      expect(row.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(row.tagName).not.toBe('BUTTON');
    }
    expect(container.querySelector('.best-card-row')).not.toBeNull();

    await act(async () => card.resolve(verifiedCard(checkBestCard.mock.calls[0][0])));
    expect(verified('Best card')).toBe(true);
    expect(text('Best pack')).toContain('Checking');
    await act(async () => pack.resolve(verifiedPack(checkBestPack.mock.calls[0][0])));
    expect(verified('Best pack')).toBe(true);
  });

  it('holds the best card place while its source is still being resolved, so the history below does not move', async () => {
    // No best card source yet (the cache is still filling), but the profile expects one.
    await render({}, true);
    expect(container.querySelector('section.profile-highlight')).not.toBeNull();
    expect(container.querySelector('.pull-row.profile-highlight-pending.best-card-row')).not.toBeNull();
    expect(container.querySelector('.profile-verified')).toBeNull();
    // Without the expectation there is nothing to hold.
    await render({}, false);
    expect(container.innerHTML).toBe('');
  });

  it('holds the place through an unranked state while the rebuild runs, then shows the note once it ends', async () => {
    // An imported or legacy save: winners are listed but have no cached cards, so the rebuild is what ranks them.
    seedBestCards();
    const store = JSON.parse(localStorage.getItem(STORAGE_KEYS.BEST_CARDS)!);
    const key = getPlayer().publicKeyHex;
    store[key].b = store[key].b.map(({ c: _drop, ...entry }: { c?: string }) => entry);
    localStorage.setItem(STORAGE_KEYS.BEST_CARDS, JSON.stringify(store));
    await render({}, true);
    expect(container.querySelector('.pull-row.profile-highlight-pending.best-card-row')).not.toBeNull();
    expect(text('Best card')).not.toContain('Not ranked yet');
    expect(checkBestCard).not.toHaveBeenCalled();
    // The rebuild ended without ranking them: the place is no longer held.
    await render({}, false);
    expect(container.querySelector('.pull-row.profile-highlight-pending.best-card-row')).toBeNull();
    expect(text('Best card')).toContain('Not ranked yet');
  });

  it('a failed check leaves the other usable and retries on request', async () => {
    seedBestCards();
    checkBestPack.mockImplementationOnce((source) => Promise.resolve({ status: 'failed', source, reason: 'error' }));
    await render();
    expect(text('Best pack')).toContain("Couldn't check your best pack just now.");
    expect(verified('Best pack')).toBe(false);
    expect(verified('Best card')).toBe(true);

    const again = [...highlight('Best pack').querySelectorAll('button')].find((b) => b.textContent === 'Try again')!;
    await act(async () => again.click());
    expect(checkBestPack).toHaveBeenCalledTimes(2);
    expect(checkBestPack.mock.calls[1][0]).toEqual(checkBestPack.mock.calls[0][0]);
    expect(verified('Best pack')).toBe(true);
    // The pressed button is gone: focus stays in the highlight, on its heading.
    expect(document.activeElement).toBe(highlight('Best pack').querySelector('h2'));
    // The card was never checked again.
    expect(checkBestCard).toHaveBeenCalledTimes(1);
  });

  it('says a pack whose ticket opens other cards is not verified, with no retry', async () => {
    seedBestCards();
    checkBestPack.mockImplementation((source) => Promise.resolve({ status: 'failed', source, reason: 'mismatch' }));
    await render();
    expect(text('Best pack')).toContain('Not verified');
    expect(highlight('Best pack').querySelector('button')).toBeNull();
    expect(highlight('Best pack').querySelector('.pull-row')).toBeNull();
    expect(verified('Best card')).toBe(true);
  });

  it('is honest about a missing source: none yet, and nothing at all on an empty profile', async () => {
    seedBestCards();
    await render({});
    expect(text('Best pack')).toContain('None yet.');
    expect(verified('Best card')).toBe(true);
    expect(checkBestPack).not.toHaveBeenCalled();

    localStorage.removeItem(STORAGE_KEYS.BEST_CARDS);
    resetBestCards();
    await render({ highestPackCards: [] });
    expect(container.innerHTML).toBe('');
  });

  it('keeps an old save’s legacy best pack unverified and checks nothing for it', async () => {
    await render({ highestPackCards: engineCards(PACK_A), highestPackFlexValue: 40, highestPackLegacy: true });
    expect(text('Best pack')).toContain('from before verifiable pulls');
    expect(verified('Best pack')).toBe(false);
    expect(checkBestPack).not.toHaveBeenCalled();
  });

  it('labels no Best card when no winner can be ranked (a list with no cached cards)', async () => {
    seedBestCards();
    const store = JSON.parse(localStorage.getItem(STORAGE_KEYS.BEST_CARDS)!);
    const key = getPlayer().publicKeyHex;
    store[key].b = store[key].b.map(({ c: _drop, ...entry }: { c?: string }) => entry);
    localStorage.setItem(STORAGE_KEYS.BEST_CARDS, JSON.stringify(store));
    await render();
    expect(text('Best card')).toContain('Not ranked yet');
    expect(highlight('Best card').querySelector('.best-card-row')).toBeNull();
    expect(checkBestCard).not.toHaveBeenCalled();
    expect(verified('Best pack')).toBe(true);
  });

  it('stops both checks when the page goes', async () => {
    seedBestCards();
    checkBestPack.mockReturnValue(new Promise(() => {}));
    checkBestCard.mockReturnValue(new Promise(() => {}));
    await render();
    const signals = [checkBestPack, checkBestCard].map((fn) => (fn.mock.calls[0][1] as CheckOptions).signal!);
    expect(signals.map((s) => s.aborted)).toEqual([false, false]);
    act(() => root.unmount());
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
    root = createRoot(container);
  });
});

describe('player identity', () => {
  it('never shows a verified result for a player switched in another tab', async () => {
    seedBestCards();
    const stats = statsFor(getPlayer().publicKeyHex);
    await render(stats);
    expect(verified('Best pack')).toBe(true);

    setPlayer(OTHER);
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: PLAYER_STORAGE_KEY })));
    expect(container.querySelector('.profile-verified')).toBeNull();
    expect(text('Best pack')).toContain("different player’s");
    // The new player has no Best cards, and the old player's pack is never checked for them.
    expect(text('Best card')).toContain('None yet.');
    expect(checkBestPack).toHaveBeenCalledTimes(1);
  });

  it('retires a check that settles after the player changed, even before anything else re-renders', async () => {
    seedBestCards();
    const pack = deferred<BestPackState>();
    checkBestPack.mockReturnValue(pack.promise);
    const stats = statsFor(getPlayer().publicKeyHex);
    await render(stats);
    setPlayer(OTHER);
    // The engine said yes for the old player's key: that must not render as the new player's.
    await act(async () => pack.resolve(verifiedPack(checkBestPack.mock.calls[0][0])));
    expect(verified('Best pack')).toBe(false);
    expect(text('Best pack')).toContain('The player changed');
  });
});
