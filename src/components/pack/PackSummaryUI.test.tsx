// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSet } from '../../content/sets';
import { getSetCards } from '../../data/cards';
import type { CardWithMeta } from '../cards/Card';
import PackSummaryUI from './PackSummaryUI';

const cache = vi.hoisted(() => ({ state: 'loading', version: 0, listeners: new Set<() => void>() }));
const { myProgress, hydrateMyPacks } = vi.hoisted(() => ({ myProgress: vi.fn(), hydrateMyPacks: vi.fn() }));
vi.mock('../../game/profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../game/profiles')>()),
  myProgress,
  hydrateMyPacks,
  myPackCacheState: () => cache.state,
  packCacheVersion: () => cache.version,
  onPackCacheChange: (listener: () => void) => {
    cache.listeners.add(listener);
    return () => cache.listeners.delete(listener);
  },
}));

// The share sheet itself is tested on its own (CardShareSheet.test.tsx): here, what it was opened with.
const { shareSheet } = vi.hoisted(() => ({ shareSheet: vi.fn() }));
vi.mock('../share/CardShareSheet', () => ({
  default: (props: { card: { name: string } }) => {
    shareSheet(props);
    return <div role="dialog">Sharing {props.card.name}</div>;
  },
}));

const setCache = (state: string) => {
  cache.state = state;
  cache.version += 1;
  for (const listener of cache.listeners) listener();
};

const set = getSet('genesis', 1)!;
const cards: CardWithMeta[] = getSetCards(set.id).slice(0, 5).map((card, i) => ({
  ...card, uniqueId: i + 1, isRevealed: true, isHolo: false, finish: null,
}) as CardWithMeta);

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  cache.state = 'loading';
  myProgress.mockReset().mockReturnValue(null);
  hydrateMyPacks.mockReset().mockResolvedValue('ready');
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

describe('level progress while saved packs are read', () => {
  it('shows a loading note instead of zero XP, then the progress once the packs are in', () => {
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Reading your saved packs');
    expect(text()).toContain('Your level progress will show');
    expect(text()).not.toMatch(/XP|Level \d/);

    myProgress.mockReturnValue({ level: 3, xp: 260, gained: 40, levelXp: 200, nextXp: 400 });
    act(() => setCache('ready'));
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(text()).toContain('+40 XP');
    expect(text()).toContain('Level 3 · 60/200 to Level 4');
  });

  it('offers a retry when the read failed, still without zero XP', () => {
    act(() => setCache('failed'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("so your level progress can't be shown yet");
    expect(text()).not.toMatch(/XP|Level \d/);
    const retry = [...container.querySelectorAll('button')].find((el) => el.textContent === 'Try again')!;
    act(() => retry.click());
    expect(hydrateMyPacks).toHaveBeenCalledTimes(1);
  });
});

describe('special cards line', () => {
  it('says how many cards are special and which kinds, and is absent for a plain pack', () => {
    expect(text()).not.toContain('special');
    const special = cards.map((card, i) => ({ ...card, isHolo: i === 0, finish: i === 1 ? 'GOLD' : null, misprint: i === 1 }) as CardWithMeta);
    act(() => root.render(<PackSummaryUI openedCards={special} set={set} onClose={() => {}} />));
    expect(container.querySelector('.summary-cards + .summary-new')?.textContent).toBe('2 special cards · Gold, Holo, Misprint');
  });
});

describe('result first', () => {
  const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('puts the heading, the cards and the score before the actions, and the keyboard on the heading', () => {
    act(() => root.unmount());
    root = createRoot(container);
    act(() => root.render(<PackSummaryUI openedCards={cards} set={set} onClose={() => {}} onShare={() => {}} holdOptional />));
    const [title, list, score, actions] = ['.summary-title', '.summary-cards', '.score-panel', '.summary-actions'].map((s) => container.querySelector(s)!);
    expect(follows(title, list) && follows(list, score) && follows(score, actions)).toBe(true);
    expect([...actions.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Share', 'Open another pack']);
    expect(document.activeElement).toBe(title);
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
    expect([...container.querySelectorAll('.summary-card')].map((el) => el.getAttribute('aria-label')?.split(',')[0])).toEqual(order);
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
