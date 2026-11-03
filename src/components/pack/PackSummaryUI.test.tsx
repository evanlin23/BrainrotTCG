// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../../constants/config';
import { cardFinishThumbUrl } from '../../content/art';
import { SETS, getSet, isOpenable } from '../../content/sets';
import { getSetCards, scoreCards } from '../../data/cards';
import type { CardWithMeta } from '../cards/Card';
import { COUNT_UP_MS } from '../../game/packTakeover';
import { TAKEOVER_DURATION_MS, revealOrder } from '../../game/reveal';
import { setMotionSetting } from '../../utils/motion';
import { STAGE_CLICK_GUARD_MS, useStageClickGuard } from '../../hooks/useStageClickGuard';
import SummaryScreen from './PackSummaryUI';

// PackOpener owns the settle window and hands it down; stand in for it, as it does for a summary just shown.
const PackSummaryUI = (props: Omit<ComponentProps<typeof SummaryScreen>, 'guard'>) => (
  <SummaryScreen {...props} guard={useStageClickGuard()} />
);

// The share sheet itself is tested on its own (CardShareSheet.test.tsx): here, what it was opened with.
const { shareSheet } = vi.hoisted(() => ({ shareSheet: vi.fn() }));
vi.mock('../share/CardShareSheet', () => ({
  default: (props: { card: { name: string } }) => {
    shareSheet(props);
    return <div role="dialog">Sharing {props.card.name}</div>;
  },
}));

// jsdom has no canvas: the full-size finish renderer is stubbed to a recognisable URL.
const { holdFinishedCardImage } = vi.hoisted(() => ({
  holdFinishedCardImage: vi.fn((src: string, finish: string) => ({ image: Promise.resolve(`rendered:${finish}:${src}`), release: () => {} })),
}));
vi.mock('../../game/finishImage', async (importOriginal) => ({ ...await importOriginal<object>(), holdFinishedCardImage }));

const set = getSet('genesis', 1)!;
const cards: CardWithMeta[] = getSetCards(set.id).slice(0, 5).map((card, i) => ({
  ...card, uniqueId: i + 1, isRevealed: true, isHolo: false, finish: null,
}) as CardWithMeta);

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Before the first render, so the summary's click guard runs on the fake clock.
  vi.useFakeTimers();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => root.render(<PackSummaryUI openedCards={cards} set={set} onClose={() => {}} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const text = () => container.textContent ?? '';
/** The summary's first moments ignore clicks on its cards and Share (#627): run the clock past them. */
const settled = () => {
  act(() => vi.advanceTimersByTime(STAGE_CLICK_GUARD_MS));
  expect(container.querySelector('.summary-cards')!.hasAttribute('data-settling')).toBe(false);
};

describe('special and new cards', () => {
  it('marks them on their tiles instead of in a line of text', () => {
    const special = cards.map((card, i) => ({ ...card, isHolo: i === 0, finish: i === 1 ? 'GOLD' : null, misprint: i === 1, isNew: i === 2 }) as CardWithMeta);
    act(() => root.render(<PackSummaryUI openedCards={special} set={set} onClose={() => {}} />));
    expect([...container.querySelectorAll('.summary-cards .mod-label')].map((el) => el.textContent)).toEqual(['Gold · Misprint']);
    expect(container.querySelectorAll('.summary-cards .new-sticker')).toHaveLength(1);
    expect(text()).not.toContain('special card');
  });
});

describe('the first moments (#627)', () => {
  it('ignores clicks on the cards, Card guide and Share, never on Open again, until the summary has settled', () => {
    // The up-close viewer measures itself and reads motion preferences.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const onShare = vi.fn();
    const onClose = vi.fn();
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<PackSummaryUI openedCards={cards} set={set} onClose={onClose} onShare={onShare} />));
    const tile = () => container.querySelector<HTMLButtonElement>('.summary-card')!;
    const share = [...container.querySelectorAll<HTMLButtonElement>('.summary-actions button')].find((b) => b.textContent?.includes('Share'))!;
    const next = [...container.querySelectorAll<HTMLButtonElement>('.summary-actions button')].find((b) => b.textContent?.includes('again'))!;
    const guide = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Card guide'))!;
    const clickAll = () => act(() => { tile().click(); share.click(); guide.click(); });

    clickAll();
    act(() => vi.advanceTimersByTime(STAGE_CLICK_GUARD_MS - 1));
    clickAll();
    expect(document.querySelector('[role="dialog"]'), 'a click in the window opened the viewer or the Card guide').toBeNull();
    expect(onShare).not.toHaveBeenCalled();
    expect(container.querySelector('.summary-caption')?.textContent, 'the hint went away as if a card had been viewed').toBe('Select a card to view');

    act(() => next.click());
    expect(onClose, 'Open again is the one deliberate move and is never held').toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(1));
    expect(container.querySelector('.summary-cards')!.hasAttribute('data-settling')).toBe(false);
    act(() => share.click());
    expect(onShare).toHaveBeenCalledTimes(1);
    act(() => tile().click());
    expect(document.querySelector('[role="dialog"]'), 'a deliberate click after the window opens the viewer').not.toBeNull();
  });
});

describe('result first', () => {
  const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('puts the heading with the score, then the Card guide, the cards, and the actions last, with the keyboard on the heading', () => {
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<PackSummaryUI openedCards={cards} set={set} onClose={() => {}} onShare={() => {}} holdOptional />));
    const [title, list, guideLine, actions] = ['.summary-title', '.summary-cards', '.summary-guide-line', '.summary-actions'].map((s) => container.querySelector(s)!);
    expect(follows(title, guideLine) && follows(guideLine, list) && follows(list, actions)).toBe(true);
    expect(actions.nextElementSibling).toBeNull();
    expect(title.textContent).toMatch(/^[\d,]+ Brainrot Score$/);
    expect([...actions.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Share', `Open ${set.name} again`]);
    expect([...guideLine.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Card guide']);
    // No per-pack breakdown and no level progress: the guide explains scoring, Profile holds progress.
    expect(text()).not.toMatch(/XP|Level \d|How this score works|pts ×/);
    expect(document.activeElement).toBe(title);
  });

  it('shows one number, the score, and no chance of it (#778)', () => {
    // A holo pair: rarer than most packs. Five plain Commons: more common than most. Neither names a chance.
    const pair = cards.map((card, i) => ({ ...(i === 1 ? cards[0] : card), uniqueId: i + 1, isHolo: i < 2 }) as CardWithMeta);
    const commons = cards.map((card) => ({ ...card, rarity: 'COMMON' }) as CardWithMeta);
    for (const opened of [pair, commons]) {
      act(() => root.render(<PackSummaryUI openedCards={opened} set={set} onClose={() => {}} />));
      expect(container.querySelector('.summary-title')!.textContent).toBe(`${scoreCards(opened).score.toLocaleString()} Brainrot Score`);
      expect(container.querySelector('.pack-headline-combo')!.textContent).toMatch(/^[A-Za-z ]+ ×\d+$/);
      expect(container.querySelector('.pack-headline-odds')).toBeNull();
      expect(text()).not.toMatch(/\b1 in\b|packs score this high|Most packs/);
    }
  });

  it('hints that a card opens up close until one is opened', () => {
    // The up-close viewer measures itself and reads motion preferences.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const caption = () => container.querySelector('.summary-caption')?.textContent;
    expect(caption()).toBe('Select a card to view');
    const first = container.querySelector<HTMLButtonElement>('.summary-card')!;
    expect(first.getAttribute('aria-label')).toMatch(/^View .+ up close, /);
    settled();
    act(() => first.click());
    expect(caption()).toBeUndefined();
  });

  it('leaves the keyboard where it is while a sheet covers the summary', () => {
    expect(document.activeElement).not.toBe(container.querySelector('.summary-title'));
  });
});

describe('card order', () => {
  it('keeps the order the cards were revealed in, best last, not best first', () => {
    // Engine order puts the Gold first and the Holo second; the reveal deals them last.
    const pack = cards.map((card, i) => ({ ...card, rarity: 'COMMON', isHolo: i === 1, finish: i === 0 ? 'GOLD' : null }) as CardWithMeta);
    const revealed = revealOrder(pack);
    act(() => root.render(<PackSummaryUI openedCards={revealed} set={set} onClose={() => {}} />));
    const tiles = [...container.querySelectorAll('.summary-card')].map((el) => el.getAttribute('aria-label'));
    expect(tiles.map((label) => revealed.findIndex((card) => label!.startsWith(`View ${card.name} up close`)))).toEqual([0, 1, 2, 3, 4]);
    expect(revealed[revealed.length - 1].finish).toBe('GOLD');
  });
});

describe('card guide', () => {
  it('shows the odds of the set version the pack came from, not the latest one (#486)', () => {
    // Web Ancients v1 is from before card modifiers; its latest version has them.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const first = getSet('web-ancients', 1)!;
    const firstCards = getSetCards(first.id).slice(0, 5).map((card, i) => ({ ...card, uniqueId: i + 1, isRevealed: true, isHolo: false }) as CardWithMeta);
    act(() => root.render(<PackSummaryUI openedCards={firstCards} set={first} onClose={() => {}} />));
    const guide = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Card guide')!;
    settled();
    act(() => guide.click());
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(`${first.name} has no finishes or misprints`);
  });
});

describe('sharing a card', () => {
  const pack = { setId: set.id, setVersion: set.version, nonce: 3, publicKeyHex: 'ab12' };
  // All Commons, so only the extras rank them: Gold (400) over Holo over plain, ties in pack order.
  const pulled = cards.map((card, i) => ({ ...card, rarity: 'COMMON', isHolo: i === 1, finish: i === 3 ? 'GOLD' : null }) as CardWithMeta);
  const tile = (name: string) => [...container.querySelectorAll<HTMLButtonElement>('.summary-card')]
    .find((el) => el.getAttribute('aria-label')?.startsWith(`View ${name} up close`))!;
  const shareCard = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Share card');

  beforeEach(() => {
    shareSheet.mockClear();
    // The viewer and the sheet's placeholder size themselves; the viewer reads motion preferences.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    act(() => root.render(<PackSummaryUI openedCards={pulled} set={set} onClose={() => {}} pack={pack} />));
  });

  it('has one hint above the cards and no Share under each tile', () => {
    const caption = container.querySelector('.summary-caption')!;
    expect(caption.textContent).toBe('Select a card to view');
    expect(!!(caption.compareDocumentPosition(container.querySelector('.summary-cards')!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(container.querySelectorAll('.summary-cards li button')).toHaveLength(5);
    expect(container.querySelector('.summary-cards')!.textContent).not.toContain('Share');
  });

  it('opens a tapped card up close, whose Share makes that version\'s image, linked to this pack', async () => {
    const gold = tile(pulled[3].name);
    settled();
    gold.focus();
    act(() => gold.click());
    const share = shareCard()!;
    expect(share).toBeDefined();
    share.focus();
    act(() => share.click());
    await vi.waitFor(() => expect(shareSheet).toHaveBeenCalled());
    const props = shareSheet.mock.lastCall![0];
    expect(props.card.uniqueId).toBe(pulled[3].uniqueId);
    expect(props.version).toEqual({ isHolo: false, finish: 'GOLD', misprint: false });
    expect(props.from).toBe(pack);

    // Closing the share returns to the viewer, and closing the viewer returns to the tile.
    act(() => props.onClose());
    expect(document.body.textContent).not.toContain(`Sharing ${pulled[3].name}`);
    await vi.waitFor(() => expect(document.activeElement).toBe(shareCard()));
    const close = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label^="Close"]')!;
    act(() => close.click());
    await vi.waitFor(() => expect(shareCard()).toBeUndefined());
    await vi.waitFor(() => expect(document.activeElement).toBe(gold));
  });
});

describe('finished card tiles (#620)', () => {
  const finished = cards.map((card, i) => ({ ...card, finish: (['SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', null] as const)[i], isHolo: i === 2, misprint: i === 3 }) as CardWithMeta);
  const tileImage = (i: number) => container.querySelectorAll<HTMLImageElement>('.summary-cards li img')[i];

  beforeEach(() => {
    holdFinishedCardImage.mockClear();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    act(() => root.render(<PackSummaryUI openedCards={finished} set={set} onClose={() => {}} />));
  });

  it("show each finish's ready-made thumbnail, with no full-size render, and keep holo and misprint marks", () => {
    for (const [i, card] of finished.entries()) {
      expect(tileImage(i).getAttribute('src')).toBe(card.finish ? cardFinishThumbUrl(card.image, card.finish) : card.image);
    }
    expect(finished.slice(0, 4).every((card) => cardFinishThumbUrl(card.image, card.finish))).toBe(true);
    expect(holdFinishedCardImage).not.toHaveBeenCalled();
    const tiles = container.querySelectorAll('.summary-card');
    expect(tiles[2].classList.contains('holo')).toBe(true);
    expect(container.querySelector('.summary-cards .mod-label')).not.toBeNull();
  });

  it('render the finish full size when its thumbnail fails to load', async () => {
    act(() => { tileImage(1).dispatchEvent(new Event('error')); });
    expect(holdFinishedCardImage).toHaveBeenCalledExactlyOnceWith(finished[1].image, 'GOLD');
    await vi.waitFor(() => expect(tileImage(1).getAttribute('src')).toBe(`rendered:GOLD:${finished[1].image}`));
  });

  it('render the finish full size up close, once the tile is opened', async () => {
    const tile = container.querySelectorAll<HTMLButtonElement>('.summary-card')[1];
    settled();
    act(() => tile.click());
    expect(holdFinishedCardImage).toHaveBeenCalledExactlyOnceWith(finished[1].image, 'GOLD');
    await vi.waitFor(() => expect(document.querySelector(`[role="dialog"] img[src="rendered:GOLD:${finished[1].image}"]`)).not.toBeNull());
    // The tile behind the viewer keeps its thumbnail.
    expect(tileImage(1).getAttribute('src')).toBe(cardFinishThumbUrl(finished[1].image, 'GOLD'));
  });
});

describe('record lines (#1287)', () => {
  const key = '0123456789abcdef0000111122223333';
  const score = scoreCards(cards).score;
  const pack = { setId: set.id, setVersion: set.version, nonce: 2, publicKeyHex: key };
  /** This player's packs on tickets 0 and 1 (stored newest first), and the one just opened on ticket 2. */
  const seed = (...earlier: number[]) => localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify([
    { s: set.id, v: set.version, n: 2, k: key.slice(0, 16), h: 'Pair', x: score, t: 3_000 },
    ...earlier.map((x, i) => ({ s: set.id, v: set.version, n: earlier.length - 1 - i, k: key.slice(0, 16), h: 'Pair', x, t: 2_000 - i })),
  ]));
  const show = () => act(() => root.render(<PackSummaryUI openedCards={cards} set={set} onClose={() => {}} pack={pack} />));
  const heading = () => container.querySelector('h2')!.textContent;

  beforeEach(() => {
    // The Hall of Fame line under the headline has nothing to load here.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  });
  afterEach(() => localStorage.clear());

  it('heads the summary with NEW BEST when the pack beats the best before it', () => {
    seed(score - 1, 1);
    show();
    // A new best opens under the pack-level takeover; once it and the count-up are done the heading reads as ever.
    act(() => vi.advanceTimersByTime(TAKEOVER_DURATION_MS));
    // A frame past the count-up's end: it is drawn a frame at a time.
    act(() => vi.advanceTimersByTime(COUNT_UP_MS + 32));
    expect(heading()).toBe(`NEW BEST:${score.toLocaleString()} Brainrot Score`);
    expect(container.querySelector('.pack-headline-previous')!.textContent).toContain(`previous best ${(score - 1).toLocaleString()}`);
  });

  it('shows none on the first pack, on a tie, or for another player', () => {
    seed();
    show();
    expect(text()).not.toContain('NEW BEST');
    seed(score, 1);
    act(() => root.render(<PackSummaryUI openedCards={cards} set={set} onClose={() => {}} pack={{ ...pack }} />));
    expect(text()).not.toContain('NEW BEST');
    seed(1);
    act(() => root.render(<PackSummaryUI openedCards={cards} set={set} onClose={() => {}} pack={{ ...pack, publicKeyHex: 'fedcba98765432100000111122223333' }} />));
    expect(text()).not.toContain('NEW BEST');
    expect(text()).not.toContain('previous best');
  });

  it("says a set best when the pack beats only its set's earlier packs, and ranks a tie with the best #2", () => {
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify([
      { s: set.id, v: set.version, n: 2, k: key.slice(0, 16), h: 'Pair', x: score, t: 3_000 },
      { s: 'other-set', v: 1, n: 1, k: key.slice(0, 16), h: 'Pair', x: score + 1, t: 2_000 },
      { s: set.id, v: set.version, n: 0, k: key.slice(0, 16), h: 'Pair', x: score - 1, t: 1_000 },
    ]));
    show();
    expect(heading()).toBe(`Best in ${set.name}:${score.toLocaleString()} Brainrot Score`);
    expect(container.querySelector('.pack-headline-previous')!.textContent).toContain(`previous set best ${(score - 1).toLocaleString()}`);
    seed(score, 1);
    act(() => root.render(<PackSummaryUI openedCards={cards} set={set} onClose={() => {}} pack={{ ...pack }} />));
    expect(container.querySelector('.pack-headline-record')).toBeNull();
    expect(container.querySelector('.pack-headline-rank')!.textContent).toBe('your #2 pack ever');
  });
});

describe('the pack-level takeover and the count-up (#1293 c)', () => {
  const key = '0123456789abcdef0000111122223333';
  const pack = { setId: set.id, setVersion: set.version, nonce: 2, publicKeyHex: key };
  const withHand = (shape: number[]): CardWithMeta[] => shape.flatMap((copies, group) => Array.from({ length: copies }, () => cards[group]))
    .map((card, i) => ({ ...card, uniqueId: i + 1 }));
  const fullHouse = withHand([3, 2]);
  const fourOfAKind = withHand([4, 1]);
  const fiveOfAKind = withHand([5]);
  const pair = withHand([2, 1, 1, 1]);
  const show = (opened: CardWithMeta[], opts: { pack?: typeof pack } = {}) =>
    act(() => root.render(<PackSummaryUI openedCards={opened} set={set} onClose={() => {}} holdOptional {...opts} />));
  const takeover = () => container.querySelector('.pack-takeover');
  const heading = () => container.querySelector('h2')!;
  /** The figure the heading shows now (the counting one while it climbs, the whole text once it is done). */
  const shown = () => {
    const live = heading().querySelector('.pack-headline-count > [aria-hidden]');
    return live ? live.textContent : heading().querySelector('.tabular')!.textContent;
  };
  const seed = (...earlier: number[]) => localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify([
    { s: set.id, v: set.version, n: 2, k: key.slice(0, 16), h: 'Pair', x: scoreCards(pair).score, t: 3_000 },
    ...earlier.map((x, i) => ({ s: set.id, v: set.version, n: earlier.length - 1 - i, k: key.slice(0, 16), h: 'Pair', x, t: 2_000 - i })),
  ]));

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  });
  afterEach(() => {
    localStorage.clear();
    setMotionSetting('auto');
  });

  it.each([
    ['a Full House', fullHouse, 'Full House', 'FULL_HOUSE'],
    ['a 4 of a Kind', fourOfAKind, '4 of a Kind', 'FOUR_OF_A_KIND'],
    ['a 5 of a Kind', fiveOfAKind, '5 of a Kind', 'FIVE_OF_A_KIND'],
  ])('opens under a takeover for %s, with its banner naming the hand and the set', (_, opened, kicker, reason) => {
    show(opened);
    expect(takeover()!.getAttribute('data-reason')).toBe(reason);
    expect(container.querySelector('.takeover-banner-kicker')!.textContent).toBe(kicker);
    expect(container.querySelector('.takeover-banner-name')!.textContent).toBe(set.name);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    // The best card's art fills the screen behind it.
    expect(container.querySelector('.takeover-art')!.getAttribute('src')).toBe(opened[opened.length - 1].image);
  });

  it('opens under a takeover for a new best, and for no other record', () => {
    seed(1, 1);
    show(pair, { pack });
    expect(container.querySelector('.takeover-banner-kicker')!.textContent).toBe('New best');
    // A set best (another set holds a higher score), a #2 and a first pack earn none.
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify([
      { s: set.id, v: set.version, n: 2, k: key.slice(0, 16), h: 'Pair', x: scoreCards(pair).score, t: 3_000 },
      { s: 'other-set', v: 1, n: 1, k: key.slice(0, 16), h: 'Pair', x: scoreCards(pair).score + 1, t: 2_000 },
      { s: set.id, v: set.version, n: 0, k: key.slice(0, 16), h: 'Pair', x: 1, t: 1_000 },
    ]));
    act(() => root.unmount());
    root = createRoot(container);
    show(pair, { pack });
    expect(container.querySelector('.pack-headline-record--set')).not.toBeNull();
    expect(takeover()).toBeNull();
    seed();
    act(() => root.unmount());
    root = createRoot(container);
    show(pair, { pack });
    expect(takeover()).toBeNull();
  });

  it('is not earned by points alone: a Diamond with nothing matching or beaten opens the summary as it always did', () => {
    const rich = cards.map((card, i) => ({ ...card, uniqueId: i + 1, rarity: 'COMMON', finish: i === 4 ? 'DIAMOND' : null }) as CardWithMeta);
    expect(scoreCards(rich).score).toBeGreaterThanOrEqual(10_000);
    show(rich);
    expect(takeover()).toBeNull();
    expect(container.querySelector('.summary-content')!.hasAttribute('inert')).toBe(false);
    expect(heading().textContent).toBe(`${scoreCards(rich).score.toLocaleString()} Brainrot Score`);
  });

  it('keeps the summary under it inert with its score at 0, then counts up on Skip and lands on the total', () => {
    show(fullHouse);
    const total = scoreCards(fullHouse).score;
    expect(container.querySelector('.summary-content')!.hasAttribute('inert')).toBe(true);
    // Still inside the settle window: a tap that was meant for the last card does not skip the moment.
    const skip = container.querySelector<HTMLButtonElement>('.pack-takeover-skip')!;
    expect(document.activeElement).toBe(skip);
    act(() => skip.click());
    expect(takeover()).not.toBeNull();
    expect(shown()).toBe('0');
    // The total stays in the heading's text for a screen reader the whole time.
    expect(heading().textContent).toContain(total.toLocaleString());
    settled();
    act(() => skip.click());
    expect(takeover()).toBeNull();
    expect(container.querySelector('.summary-content')!.hasAttribute('inert')).toBe(false);
    // The keyboard lands on the result, as on any summary.
    expect(document.activeElement).toBe(heading());
    expect(shown()).toBe('0');
    act(() => vi.advanceTimersByTime(COUNT_UP_MS / 2));
    const middle = Number(shown()!.replace(/,/g, ''));
    expect(middle).toBeGreaterThan(0);
    expect(middle).toBeLessThan(total);
    act(() => vi.advanceTimersByTime(COUNT_UP_MS));
    expect(heading().querySelector('.pack-headline-count')).toBeNull();
    expect(heading().textContent).toBe(`${total.toLocaleString()} Brainrot Score`);
  });

  it('ends by itself, and Space or Enter with no button focused settles it without closing the summary', () => {
    const onClose = vi.fn();
    act(() => root.render(<PackSummaryUI openedCards={fullHouse} set={set} onClose={onClose} holdOptional />));
    // Inside the settle window a key does nothing yet, and is still kept from the pack's own keys.
    const press = (code: string) => {
      const event = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true });
      act(() => { document.body.dispatchEvent(event); });
      return event;
    };
    expect(press('Space').defaultPrevented).toBe(true);
    expect(takeover()).not.toBeNull();
    settled();
    expect(press('Enter').defaultPrevented).toBe(true);
    expect(takeover()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // A summary of its own: this one's takeover has settled.
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<PackSummaryUI openedCards={fourOfAKind} set={set} onClose={onClose} holdOptional />));
    expect(takeover()).not.toBeNull();
    act(() => vi.advanceTimersByTime(TAKEOVER_DURATION_MS - 1));
    expect(takeover()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(takeover()).toBeNull();
  });

  it('leaves a button its own keys, so the X and Skip work as ever', () => {
    show(fullHouse);
    settled();
    const other = document.body.appendChild(document.createElement('button'));
    const event = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
    act(() => { other.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(takeover()).not.toBeNull();
    other.remove();
  });

  it('takes no key while a sheet covers the summary', () => {
    act(() => root.render(<PackSummaryUI openedCards={fullHouse} set={set} onClose={() => {}} holdOptional={false} />));
    const event = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
    act(() => { document.body.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    expect(takeover()).not.toBeNull();
    expect(document.activeElement).not.toBe(container.querySelector('.pack-takeover-skip'));
  });

  it('lands on the total at once when it settles under the Motion setting', () => {
    setMotionSetting('reduced');
    show(fullHouse);
    settled();
    act(() => container.querySelector<HTMLButtonElement>('.pack-takeover-skip')!.click());
    expect(takeover()).toBeNull();
    expect(heading().querySelector('.pack-headline-count')).toBeNull();
    expect(heading().textContent).toBe(`${scoreCards(fullHouse).score.toLocaleString()} Brainrot Score`);
  });

  it('lands on the total at once under the device\'s reduced-motion setting too', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('prefers-reduced-motion'), addEventListener() {}, removeEventListener() {} }));
    show(fullHouse);
    act(() => vi.advanceTimersByTime(TAKEOVER_DURATION_MS));
    expect(takeover()).toBeNull();
    expect(heading().textContent).toBe(`${scoreCards(fullHouse).score.toLocaleString()} Brainrot Score`);
  });

  it('counts nothing up for a pack with no takeover', () => {
    show(pair);
    expect(heading().querySelector('.pack-headline-count')).toBeNull();
    expect(heading().textContent).toBe(`${scoreCards(pair).score.toLocaleString()} Brainrot Score`);
  });
});

describe('the stuck actions\' height', () => {
  it('is published on the list, so scrolling something into view stops above the actions however tall they are', () => {
    const observed: Element[] = [];
    let notify = () => {};
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notify = callback; }
      observe(element: Element) { observed.push(element); }
      disconnect() {}
    });
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
    try {
      act(() => root.unmount());
      root = createRoot(container);
      act(() => root.render(<PackSummaryUI openedCards={cards} set={set} onClose={() => {}} onShare={() => {}} />));
      const list = container.querySelector<HTMLElement>('.summary-content')!;
      expect(observed).toEqual([container.querySelector('.summary-actions')]);
      expect(list.style.getPropertyValue('--summary-actions-height')).toBe('120px');
      // Large text makes them taller: the padding follows.
      height.mockReturnValue(314);
      act(() => notify());
      expect(list.style.getPropertyValue('--summary-actions-height')).toBe('314px');
    } finally {
      height.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe('Try another pack (#898)', () => {
  const openable = SETS.filter(isOpenable);
  const shown = (extra: Partial<ComponentProps<typeof SummaryScreen>> = {}) => {
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<PackSummaryUI openedCards={cards} set={set} onClose={() => {}} onShare={() => {}} {...extra} />));
  };
  const tryAnother = () => [...container.querySelectorAll<HTMLButtonElement>('.summary-try-another')].find((b) => b.textContent?.includes('Try another pack'));
  const actions = () => [...container.querySelectorAll('.summary-try-another, .summary-actions button')].map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());

  it('names the primary for the set it opens again, and keeps it the last and only primary action', () => {
    shown({ packChoices: { sets: openable, collection: {}, onOpen: () => {} } });
    const primary = container.querySelector<HTMLButtonElement>('.summary-actions .btn--primary')!;
    expect(primary.textContent?.trim()).toBe(`Open ${set.name} again`);
    expect(container.querySelectorAll('.summary-actions .btn--primary')).toHaveLength(1);
    expect(container.querySelector('.summary-actions')!.lastElementChild).toBe(primary);
    expect(container.querySelector('.summary-actions')!.nextElementSibling).toBeNull();
  });

  it('puts a control between the cards and the stuck actions, whose name counts the other packs, and opens the Packs sheet from it', () => {
    const onOpen = vi.fn();
    shown({ packChoices: { sets: openable, collection: {}, onOpen } });
    expect(openable.length).toBeGreaterThan(1);
    const others = openable.filter((s) => s.id !== set.id).length;
    expect(actions()).toEqual(['Try another pack' + `, ${others} other ${others === 1 ? 'pack' : 'packs'} to choose from`, 'Share', `Open ${set.name} again`]);
    const button = tryAnother()!;
    // Outside the stuck row, so that row keeps the height it had before: only Share and the primary are in it.
    expect(button.closest('.summary-actions')).toBeNull();
    expect(button.previousElementSibling).toBe(container.querySelector('.summary-cards'));
    expect(button.nextElementSibling).toBe(container.querySelector('.summary-actions'));
    expect([...container.querySelectorAll('.summary-actions button')].map((b) => b.textContent?.trim())).toEqual(['Share', `Open ${set.name} again`]);
    expect(button.textContent, 'the visible words are the start of the accessible name').toBe('Try another pack');
    expect(button.querySelectorAll('img')).toHaveLength(Math.min(2, others));
    expect(button.querySelector('.summary-try-thumbs')!.getAttribute('aria-hidden')).toBe('true');
    settled();
    act(() => button.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('says "1 other pack" when only one more is listed', () => {
    const two = [openable.find((s) => s.id !== set.id)!, set];
    shown({ packChoices: { sets: two, collection: {}, onOpen: () => {} } });
    expect(tryAnother()!.getAttribute('aria-label')).toBe('Try another pack, 1 other pack to choose from');
    expect(tryAnother()!.textContent).toBe('Try another pack');
    expect(tryAnother()!.querySelectorAll('img')).toHaveLength(1);
  });

  it('sizes the wrapper thumbnails up front, so their load never moves the layout', () => {
    shown({ packChoices: { sets: openable, collection: {}, onOpen: () => {} } });
    for (const img of tryAnother()!.querySelectorAll('img')) {
      expect(img.getAttribute('width')).toBe('16');
      expect(img.getAttribute('height')).toBe('28');
      expect(img.getAttribute('loading')).toBeNull();
    }
  });

  it('shows nothing new, and no layout change, with one available set or no choices at all', () => {
    shown();
    const plain = container.querySelector('.summary-actions')!.innerHTML;
    expect(tryAnother()).toBeUndefined();
    shown({ packChoices: { sets: [set], collection: {}, onOpen: () => {} } });
    expect(tryAnother()).toBeUndefined();
    expect(container.querySelector('.summary-actions')!.innerHTML).toBe(plain);
    expect(actions()).toEqual(['Share', `Open ${set.name} again`]);
  });

  it('holds a click inside the settle window like Share, so a stray tap on the last card cannot open the sheet', () => {
    const onOpen = vi.fn();
    shown({ packChoices: { sets: openable, collection: {}, onOpen } });
    act(() => tryAnother()!.click());
    expect(onOpen).not.toHaveBeenCalled();
    settled();
    act(() => tryAnother()!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
