// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSet } from '../../content/sets';
import { getSetCards, scoreCards } from '../../data/cards';
import { scoreAtLeastChance } from '../../engine';
import type { CardWithMeta } from '../cards/Card';
import { revealOrder } from '../../game/reveal';
import PackSummaryUI from './PackSummaryUI';

// The share sheet itself is tested on its own (CardShareSheet.test.tsx): here, what it was opened with.
const { shareSheet } = vi.hoisted(() => ({ shareSheet: vi.fn() }));
vi.mock('../share/CardShareSheet', () => ({
  default: (props: { card: { name: string } }) => {
    shareSheet(props);
    return <div role="dialog">Sharing {props.card.name}</div>;
  },
}));

const set = getSet('genesis', 1)!;
const cards: CardWithMeta[] = getSetCards(set.id).slice(0, 5).map((card, i) => ({
  ...card, uniqueId: i + 1, isRevealed: true, isHolo: false, finish: null,
}) as CardWithMeta);

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  act(() => root.render(<PackSummaryUI openedCards={cards} set={set} onClose={() => {}} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const text = () => container.textContent ?? '';

describe('special and new cards', () => {
  it('marks them on their tiles instead of in a line of text', () => {
    const special = cards.map((card, i) => ({ ...card, isHolo: i === 0, finish: i === 1 ? 'GOLD' : null, misprint: i === 1, isNew: i === 2 }) as CardWithMeta);
    act(() => root.render(<PackSummaryUI openedCards={special} set={set} onClose={() => {}} />));
    expect([...container.querySelectorAll('.summary-cards .mod-label')].map((el) => el.textContent)).toEqual(['Gold · Misprint']);
    expect(container.querySelectorAll('.summary-cards .new-sticker')).toHaveLength(1);
    expect(text()).not.toContain('special card');
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
    expect([...actions.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Share', 'Open another pack']);
    expect([...guideLine.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Card guide']);
    // No per-pack breakdown and no level progress: the guide explains scoring, Profile holds progress.
    expect(text()).not.toMatch(/XP|Level \d|How this score works|pts ×/);
    expect(document.activeElement).toBe(title);
  });

  it('says how rare a score this high is, over the whole pack', () => {
    // A holo pair: rarer than most packs.
    const pair = cards.map((card, i) => ({ ...(i === 1 ? cards[0] : card), uniqueId: i + 1, isHolo: i < 2 }) as CardWithMeta);
    act(() => root.render(<PackSummaryUI openedCards={pair} set={set} onClose={() => {}} />));
    const odds = () => container.querySelector('.pack-headline-odds')?.textContent;
    const chance = scoreAtLeastChance(set, scoreCards(pair).score)!;
    expect(chance).toBeLessThan(0.5);
    const oneIn = 1 / chance;
    expect(odds()).toBe(`Pair · 1 in ${oneIn < 10 ? oneIn.toFixed(1) : Math.round(oneIn).toLocaleString()} packs score this high`);
    // Five plain Commons: most packs do at least that well.
    const commons = cards.map((card) => ({ ...card, rarity: 'COMMON' }) as CardWithMeta);
    act(() => root.render(<PackSummaryUI openedCards={commons} set={set} onClose={() => {}} />));
    expect(odds()).toBe('No Matches · Most packs score this high');
  });

  it('hints that a card opens up close until one is opened', () => {
    // The up-close viewer measures itself and reads motion preferences.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const caption = () => container.querySelector('.summary-caption')?.textContent;
    expect(caption()).toBe('Tap a card to view');
    const first = container.querySelector<HTMLButtonElement>('.summary-card')!;
    expect(first.getAttribute('aria-label')).toMatch(/^View .+ up close, /);
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
    expect(caption.textContent).toBe('Tap a card to view');
    expect(!!(caption.compareDocumentPosition(container.querySelector('.summary-cards')!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(container.querySelectorAll('.summary-cards li button')).toHaveLength(5);
    expect(container.querySelector('.summary-cards')!.textContent).not.toContain('Share');
  });

  it('opens a tapped card up close, whose Share makes that version\'s image, linked to this pack', async () => {
    const gold = tile(pulled[3].name);
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
