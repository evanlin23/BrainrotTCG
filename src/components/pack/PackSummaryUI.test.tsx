// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSet } from '../../content/sets';
import { getSetCards, scoreCards } from '../../data/cards';
import { scoreAtLeastChance } from '../../engine';
import type { CardWithMeta } from '../cards/Card';
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
    expect(caption()).toBe('Tap a card to see it up close');
    const first = container.querySelector<HTMLButtonElement>('.summary-card')!;
    expect(first.getAttribute('aria-label')).toMatch(/^View .+ up close, /);
    act(() => first.click());
    expect(caption()).toBeUndefined();
  });

  it('leaves the keyboard where it is while a sheet covers the summary', () => {
    expect(document.activeElement).not.toBe(container.querySelector('.summary-title'));
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

describe('each card\'s own Share', () => {
  const pack = { setId: set.id, setVersion: set.version, nonce: 3, publicKeyHex: 'ab12' };
  // All Commons, so only the extras rank them: Gold (400) over Holo over plain, ties in pack order.
  const pulled = cards.map((card, i) => ({ ...card, rarity: 'COMMON', isHolo: i === 1, finish: i === 3 ? 'GOLD' : null }) as CardWithMeta);
  const shareButtons = () => [...container.querySelectorAll<HTMLButtonElement>('.summary-card-share')];

  beforeEach(() => {
    shareSheet.mockClear();
    // The sheet's placeholder sizes itself while the share screen loads.
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    act(() => root.render(<PackSummaryUI openedCards={pulled} set={set} onClose={() => {}} pack={pack} />));
  });

  it('lays the cards out best pull first, each with a Share or save for it', () => {
    const order = [3, 1, 0, 2, 4].map((i) => pulled[i].name);
    // The modifier is part of each button's name, so two copies of one card stay distinguishable.
    const mods = ['Gold', 'Holo', null, null, null];
    expect(shareButtons().map((b) => b.getAttribute('aria-label'))).toEqual(
      order.map((name, k) => `Share or save ${name}${mods[k] ? `, ${mods[k]}` : ''}`),
    );
    expect([...container.querySelectorAll('.summary-card')].map((el) => el.getAttribute('aria-label')?.split(',')[0])).toEqual(order.map((name) => `View ${name} up close`));
    expect(shareButtons().every((b) => b.textContent?.trim() === 'Share')).toBe(true);
  });

  it('opens that card\'s image, linked to this pack', async () => {
    act(() => shareButtons()[0].click());
    await vi.waitFor(() => expect(shareSheet).toHaveBeenCalled());
    const props = shareSheet.mock.lastCall![0];
    expect(props.card.uniqueId).toBe(pulled[3].uniqueId);
    expect(props.version).toEqual({ isHolo: false, finish: 'GOLD', misprint: false });
    expect(props.from).toBe(pack);
    expect(container.querySelector('[role="dialog"]')?.textContent).toBe(`Sharing ${pulled[3].name}`);

    act(() => props.onClose());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('has no per-card Share without the pull to link to', () => {
    act(() => root.render(<PackSummaryUI openedCards={pulled} set={set} onClose={() => {}} />));
    expect(shareButtons()).toEqual([]);
  });
});
