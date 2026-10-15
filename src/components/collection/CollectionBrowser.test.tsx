// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS, COLLECTIBLE_CARDS, getSetCards, type Card } from '../../data/cards';
import { isOpenable, SETS } from '../../content/sets';
import type { Finish, SetDefinition } from '../../engine';
import type { CollectionItem } from '../../types';
import CollectionBrowser from './CollectionBrowser';

const { finishedCardImage } = vi.hoisted(() => ({ finishedCardImage: vi.fn(async (src: string) => `rendered:${src}`) }));
// jsdom has no canvas; counting calls shows which tiles asked for finish work.
vi.mock('../../game/finishImage', () => ({ finishedCardImage }));

const FINISHES: Finish[] = ['SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'];
const RARITIES = ['COMMON', 'COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY'] as const;

/** Every card in `cards` owned (unless `skip` says not), with the same spread of holos, finishes and misprints the browser measurement used. */
const own = (cards: Card[], skip = (_index: number) => false): Record<string, CollectionItem> =>
  Object.fromEntries(cards.flatMap((card, i) => skip(i) ? [] : [[card.key, {
    card, normalCount: 1 + (i % 3), holoCount: i % 4 === 0 ? 1 : 0,
    ...(i % 5 === 0 ? { finishes: { [FINISHES[i % 4]]: 1 } } : {}),
    ...(i % 11 === 0 ? { misprints: 1 } : {}),
  } satisfies CollectionItem]]));

/**
 * Future-growth fixture: 30 more 12-card eras after today's, registered in place for one test.
 * Their art has no ready-made finish thumbnails, so every finished tile that mounts asks for a
 * rendered finish: the worst case for offscreen work.
 */
const FUTURE_SETS = 30;
const addFutureSets = () => {
  const template = SETS[SETS.length - 1];
  const added: SetDefinition[] = Array.from({ length: FUTURE_SETS }, (_, n) => ({
    ...template, id: `future-${n + 1}`, name: `Future era ${n + 1}`, era: `${2027 + n}`, draft: undefined, archivedAt: undefined,
  }));
  const cards: Card[] = added.flatMap((set) => Array.from({ length: 12 }, (_, k) => ({
    key: `${set.id}/card-${k + 1}`, setId: set.id, id: `card-${k + 1}`, name: `${set.name} card ${k + 1}`,
    rarity: RARITIES[k % RARITIES.length], image: `/future/${set.id}/card-${k + 1}.webp`,
  })));
  SETS.push(...added);
  ALL_CARDS.push(...cards);
  COLLECTIBLE_CARDS.push(...cards);
  return cards;
};
const registry = { sets: SETS.length, all: ALL_CARDS.length, collectible: COLLECTIBLE_CARDS.length };

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no ResizeObserver or matchMedia; the sheet and card viewer only use them for layout and tilt.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  finishedCardImage.mockClear();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  SETS.length = registry.sets;
  ALL_CARDS.length = registry.all;
  COLLECTIBLE_CARDS.length = registry.collectible;
});

const render = (collection: Record<string, CollectionItem>) =>
  act(() => root.render(<CollectionBrowser collection={collection} onClose={() => {}} />));

const sheet = () => document.querySelector<HTMLElement>('.sheet.collection')!;
const headers = () => [...sheet().querySelectorAll<HTMLButtonElement>('.collection-set-toggle')];
const mountedPockets = () => sheet().querySelectorAll('.collection-grid > li').length;
const tiles = (root: ParentNode = sheet()) => [...root.querySelectorAll<HTMLButtonElement>('.collection-grid button.collection-item')];
const gridOf = (header: HTMLButtonElement) => document.getElementById(header.getAttribute('aria-controls')!);
/** What the grid mounted before #344: a pocket per card of every started openable set, the owned cards of the rest. */
const unboundedPockets = (collection: Record<string, CollectionItem>) =>
  SETS.reduce((n, set) => {
    const have = getSetCards(set.id).filter((card) => collection[card.key]).length;
    return have === 0 ? n : n + (isOpenable(set) ? getSetCards(set.id).length : have);
  }, 0);
const expandAll = () => {
  for (const header of headers()) if (header.getAttribute('aria-expanded') === 'false') act(() => header.click());
};

describe('bounded collection grid (#344)', () => {
  it("mounts only the first eras' pockets for today's full collection", () => {
    const collection = own(SETS.flatMap((set) => getSetCards(set.id)));
    render(collection);
    // Genesis (19 owned, archived) fills the opening budget; the old grid mounted every era at once.
    expect(unboundedPockets(collection)).toBeGreaterThanOrEqual(127);
    expect(mountedPockets()).toBe(19);
    expect(sheet().querySelectorAll('.collection-grid img')).toHaveLength(19);
    expect(headers().map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', ...SETS.slice(1).map(() => 'false')]);
    expect(headers().slice(1).every((h) => gridOf(h) === null)).toBe(true);
  });

  it('keeps the bound for a future-growth collection of 40 eras, without finish work for collapsed ones', () => {
    const future = addFutureSets();
    const collection = own(SETS.flatMap((set) => getSetCards(set.id)));
    render(collection);
    expect(SETS).toHaveLength(registry.sets + FUTURE_SETS);
    expect(unboundedPockets(collection)).toBe(registry.all + future.length);
    expect(mountedPockets()).toBe(19);
    expect(finishedCardImage).not.toHaveBeenCalled();

    // Opening one future era renders its finishes (no thumbnails), and only its own.
    const last = headers()[headers().length - 1];
    act(() => last.click());
    const finished = tiles(gridOf(last)!).filter((tile) => tile.classList.contains('has-finish'));
    expect(finished.length).toBeGreaterThan(0);
    expect(finishedCardImage).toHaveBeenCalledTimes(finished.length);
    expect(mountedPockets()).toBe(19 + 12);
  });

  it('opens every era for a small collection, as before', () => {
    const [first, second] = SETS.filter(isOpenable);
    render(own([...getSetCards(first.id).slice(0, 5), ...getSetCards(second.id).slice(0, 3)]));
    expect(headers().map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
    expect(mountedPockets()).toBe(24);
    expect(tiles()).toHaveLength(8);
  });

  it('opens eras in timeline order until the budget is spent, then stops', () => {
    const [first, second, third] = SETS.filter(isOpenable);
    render(own([getSetCards(first.id)[0], getSetCards(second.id)[0], getSetCards(third.id)[0]]));
    expect(headers().map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'true', 'false']);
    expect(mountedPockets()).toBe(24);
  });
});

describe('every owned card stays reachable', () => {
  it('shows every owned card, its counts and collector number, and the totals, once each era is opened', () => {
    addFutureSets();
    // Every seventh card missing, so openable eras show empty pockets and archived ones skip them.
    const collection = own(ALL_CARDS, (i) => i % 7 === 3);
    const owned = Object.values(collection);
    render(collection);
    const ownedCollectible = COLLECTIBLE_CARDS.filter((card) => collection[card.key]).length;
    expect(sheet().querySelector('.sheet-subtitle')!.textContent).toMatch(new RegExp(`^${ownedCollectible}/${COLLECTIBLE_CARDS.length} cards · `));

    expandAll();
    expect(headers().every((h) => h.getAttribute('aria-expanded') === 'true')).toBe(true);
    expect(mountedPockets()).toBe(unboundedPockets(collection));
    const labels = tiles().map((tile) => tile.getAttribute('aria-label'));
    expect(labels).toHaveLength(owned.length);

    for (const set of SETS) {
      const cards = getSetCards(set.id);
      const have = cards.filter((card) => collection[card.key]);
      const header = headers().find((h) => h.querySelector('.collection-set-name')!.textContent === set.name)!;
      expect(header.querySelector('.collection-set-count')!.textContent).toBe(`${have.length}/${cards.length}`);
      const grid = gridOf(header)!;
      expect(grid.children).toHaveLength(isOpenable(set) ? cards.length : have.length);
      expect(grid.querySelectorAll('.collection-slot')).toHaveLength(isOpenable(set) ? cards.length - have.length : 0);
      for (const card of have) {
        const { normalCount, holoCount } = collection[card.key];
        const number = `${String(cards.indexOf(card) + 1).padStart(3, '0')}/${String(cards.length).padStart(3, '0')}`;
        const name = card.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        expect(labels).toContainEqual(expect.stringMatching(new RegExp(`^${name}, ${number}, .*, ${normalCount + holoCount} owned${holoCount ? `, ${holoCount} holo` : ''}`)));
      }
    }
  });

  it('works from the keyboard: headers are buttons that keep focus, and a card returns focus to its tile', () => {
    render(own(SETS.flatMap((set) => getSetCards(set.id))));
    const header = headers()[1];
    expect(header.closest('h3')).not.toBeNull();
    expect(header.getAttribute('aria-expanded')).toBe('false');
    header.focus();
    act(() => header.click());
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(header);

    const tile = tiles(gridOf(header)!)[0];
    tile.focus();
    act(() => tile.click());
    const viewer = document.querySelector<HTMLElement>('.sheet.card-viewer')!;
    expect(viewer).not.toBeNull();
    expect([...viewer.querySelectorAll('button')].some((b) => b.textContent?.includes('Share card'))).toBe(true);
    act(() => { viewer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('.sheet.card-viewer')).toBeNull();
    expect(document.activeElement).toBe(tile);
    expect(header.getAttribute('aria-expanded')).toBe('true');

    header.focus();
    act(() => header.click());
    expect(gridOf(header)).toBeNull();
    expect(document.activeElement).toBe(header);
  });

  it('keeps the empty and not-started views', () => {
    render({});
    expect(headers()).toHaveLength(0);
    expect(sheet().querySelector('.collection-empty')!.textContent).toBe('Open packs to start your collection.');
    expect(sheet().querySelectorAll('.collection-later li')).toHaveLength(SETS.filter(isOpenable).length);
  });
});
