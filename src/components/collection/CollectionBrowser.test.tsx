// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS, COLLECTIBLE_CARDS, getSetCards, type Card } from '../../data/cards';
import { isOpenable, SETS } from '../../content/sets';
import type { Finish, SetDefinition } from '../../engine';
import type { CollectionItem } from '../../types';
import CollectionBrowser from './CollectionBrowser';

const { holdFinishedCardImage } = vi.hoisted(() => ({
  holdFinishedCardImage: vi.fn((src: string) => ({ image: Promise.resolve(`rendered:${src}`), release: () => {} })),
}));
// jsdom has no canvas; counting calls shows which tiles asked for finish work.
vi.mock('../../game/finishImage', () => ({ holdFinishedCardImage }));

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
 * Future-growth fixture: 30 more 12-card eras (or `count` eras of `size` cards) after today's,
 * registered in place for one test. Their art has no ready-made finish thumbnails, so every finished
 * tile that mounts asks for a rendered finish: the worst case for offscreen work.
 */
const FUTURE_SETS = 30;
const addFutureSets = (count = FUTURE_SETS, size = 12) => {
  const template = SETS[SETS.length - 1];
  const added: SetDefinition[] = Array.from({ length: count }, (_, n) => ({
    ...template, id: `future-${n + 1}`, name: `Future era ${n + 1}`, era: `${2027 + n}`, draft: undefined, archivedAt: undefined,
  }));
  const cards: Card[] = added.flatMap((set) => Array.from({ length: size }, (_, k) => ({
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
  // jsdom has no ResizeObserver or matchMedia; the card viewer only use them for layout and tilt.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  holdFinishedCardImage.mockClear();
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

const render = (collection: Record<string, CollectionItem>, recentSetId?: string) =>
  act(() => root.render(<CollectionBrowser collection={collection} recentSetId={recentSetId} />));
/** A fresh page: which eras open is decided when it mounts. */
const remount = () => {
  act(() => root.unmount());
  root = createRoot(container);
};

const page = () => document.querySelector<HTMLElement>('.collection')!;
const headers = () => [...page().querySelectorAll<HTMLButtonElement>('.collection-set-toggle')];
const mountedPockets = () => page().querySelectorAll('.collection-grid > li').length;
const tiles = (root: ParentNode = page()) => [...root.querySelectorAll<HTMLButtonElement>('.collection-grid button.collection-item')];
const gridOf = (header: HTMLButtonElement) => {
  const id = header.getAttribute('aria-controls');
  return id ? document.getElementById(id) : null;
};
const nameOf = (header: HTMLButtonElement) => header.querySelector('.collection-set-name')!.textContent;
const headerOf = (name: string) => headers().find((h) => nameOf(h) === name)!;
/** Names of the eras whose grid is showing, in timeline order. */
const openEras = () => headers().filter((h) => h.getAttribute('aria-expanded') === 'true').map(nameOf);
const setNamed = (name: string) => SETS.find((set) => set.name === name)!;
const finishedTiles = (root?: ParentNode) => tiles(root).filter((tile) => tile.classList.contains('has-finish')).length;
/** What the grid mounted before #344: a pocket per card of every started openable set, the owned cards of the rest. */
const unboundedPockets = (collection: Record<string, CollectionItem>) =>
  SETS.reduce((n, set) => {
    const have = getSetCards(set.id).filter((card) => collection[card.key]).length;
    return have === 0 ? n : n + (isOpenable(set) ? getSetCards(set.id).length : have);
  }, 0);
/**
 * Opens every collapsed era in one batch. One act per header re-rendered the whole page, every grid
 * already open included, once per era: quadratic work that took seconds on a loaded machine.
 */
const expandAll = () => {
  const collapsed = headers().filter((header) => header.getAttribute('aria-expanded') === 'false');
  act(() => { for (const header of collapsed) header.click(); });
};

describe('bounded collection grid (#344)', () => {
  it("mounts only the newest eras' pockets for today's full collection", () => {
    const collection = own(SETS.flatMap((set) => getSetCards(set.id)));
    render(collection);
    // The two newest 12-card eras fill the opening budget; the old grid mounted every era at once.
    const [newest, previous] = [...SETS].reverse();
    expect(unboundedPockets(collection)).toBeGreaterThanOrEqual(127);
    expect(openEras()).toEqual([previous.name, newest.name]);
    expect(mountedPockets()).toBe(24);
    expect(page().querySelectorAll('.collection-grid img')).toHaveLength(24);
    // Only a showing grid is named by its header; a collapsed header controls nothing mounted.
    for (const header of headers()) {
      if (header.getAttribute('aria-expanded') === 'true') expect(gridOf(header)!.matches('ul.collection-grid')).toBe(true);
      else expect(header.hasAttribute('aria-controls')).toBe(false);
    }
  });

  it('keeps the bound for a future-growth collection of 40 eras, without finish work for collapsed ones', () => {
    const future = addFutureSets();
    const collection = own(SETS.flatMap((set) => getSetCards(set.id)));
    render(collection);
    expect(SETS).toHaveLength(registry.sets + FUTURE_SETS);
    expect(unboundedPockets(collection)).toBe(registry.all + future.length);
    expect(openEras()).toEqual([`Future era ${FUTURE_SETS - 1}`, `Future era ${FUTURE_SETS}`]);
    expect(mountedPockets()).toBe(24);
    // Only the two open eras rendered finishes (their art has no thumbnails); the 38 collapsed did none.
    const opened = finishedTiles();
    expect(opened).toBeGreaterThan(0);
    expect(holdFinishedCardImage).toHaveBeenCalledTimes(opened);

    // Opening one more future era renders its own finishes, and only those.
    const oldest = headerOf('Future era 1');
    act(() => oldest.click());
    const added = finishedTiles(gridOf(oldest)!);
    expect(added).toBeGreaterThan(0);
    expect(holdFinishedCardImage).toHaveBeenCalledTimes(opened + added);
    expect(mountedPockets()).toBe(24 + 12);
  });

  it('opens every era for a small collection, as before', () => {
    const [first, second] = SETS.filter(isOpenable);
    render(own([...getSetCards(first.id).slice(0, 5), ...getSetCards(second.id).slice(0, 3)]));
    expect(headers().map((h) => h.getAttribute('aria-expanded'))).toEqual(['true', 'true']);
    expect(mountedPockets()).toBe(24);
    expect(tiles()).toHaveLength(8);
  });

  it('opens eras newest first until the budget is spent, then stops', () => {
    const [first, second, third] = SETS.filter(isOpenable);
    render(own([getSetCards(first.id)[0], getSetCards(second.id)[0], getSetCards(third.id)[0]]));
    expect(headers().map((h) => h.getAttribute('aria-expanded'))).toEqual(['false', 'true', 'true']);
    expect(mountedPockets()).toBe(24);
  });

  it('opens the era you just pulled from, even when older and newer eras would fill the budget', () => {
    // 19 Genesis cards, a Summer of Slop pack, a card from each of two newer eras, then Cards.
    addFutureSets(2);
    const genesis = setNamed('Genesis');
    const slop = setNamed('Summer of Slop');
    const collection = own([...getSetCards(genesis.id), ...getSetCards(slop.id).slice(0, 5), getSetCards('future-1')[0], getSetCards('future-2')[0]]);
    // Without a selected era, the two newer eras fill the budget and Summer of Slop starts collapsed.
    render(collection);
    expect(openEras()).toEqual(['Future era 1', 'Future era 2']);
    remount();
    render(collection, slop.id);
    expect(getSetCards(genesis.id)).toHaveLength(19);
    expect(openEras()).toEqual([slop.name, 'Future era 2']);
    expect(gridOf(headerOf(genesis.name))).toBeNull();
    expect(gridOf(headerOf('Future era 1'))).toBeNull();
    expect(mountedPockets()).toBe(24);
    expect(tiles(gridOf(headerOf(slop.name))!)).toHaveLength(5);
  });

  it('opens the selected era before newer ones, then spends what is left newest first', () => {
    const [oldest, , , middle] = SETS.filter(isOpenable);
    const newest = SETS[SETS.length - 1];
    render(own([oldest, middle, newest].map((set) => getSetCards(set.id)[0])), oldest.id);
    expect(openEras()).toEqual([oldest.name, newest.name]);
    expect(gridOf(headerOf(middle.name))).toBeNull();
    expect(mountedPockets()).toBe(24);
  });

  it.each([
    ['as the selected era', 'future-1'],
    ['as the newest era, without a selected one', undefined],
  ])('always opens an era bigger than the budget %s', (_, recentSetId) => {
    addFutureSets(1, 30);
    const big = setNamed('Future era 1');
    const [older] = SETS.filter(isOpenable);
    render(own([getSetCards(older.id)[0], ...getSetCards(big.id).slice(0, 3)]), recentSetId);
    expect(openEras()).toEqual([big.name]);
    expect(mountedPockets()).toBe(30);
    expect(tiles()).toHaveLength(3);
  });

  it('shows an era started while the page is open with its grid open', () => {
    const [first] = SETS.filter(isOpenable);
    const rest = SETS.filter((set) => set.id !== first.id).flatMap((set) => getSetCards(set.id));
    render(own(rest));
    expect(mountedPockets()).toBe(24);
    render(own([...rest, getSetCards(first.id)[0]]));
    expect(headerOf(first.name).getAttribute('aria-expanded')).toBe('true');
    expect(gridOf(headerOf(first.name))!.children).toHaveLength(getSetCards(first.id).length);
    expect(mountedPockets()).toBe(24 + getSetCards(first.id).length);
  });
});

describe('every owned card stays reachable', () => {
  it('shows every owned card, its counts and collector number, and the totals, once each era is opened', () => {
    // A few eras past today's prove newer art is reachable too; the 40-era scale is the bound test's job,
    // and opening 30 more eras here meant mounting ~1,000 tiles in jsdom for no extra coverage.
    addFutureSets(3);
    // Every seventh card missing, so openable eras show empty pockets and archived ones skip them.
    const collection = own(ALL_CARDS, (i) => i % 7 === 3);
    const owned = Object.values(collection);
    render(collection);
    const ownedCollectible = COLLECTIBLE_CARDS.filter((card) => collection[card.key]).length;
    expect(page().querySelector('.page-subtitle')!.textContent).toMatch(new RegExp(`^${ownedCollectible}/${COLLECTIBLE_CARDS.length} cards · `));

    // Card points are not a pack's Brainrot Score (that includes the combo multiplier).
    expect(page().querySelector('.page-subtitle')!.textContent).toMatch(/ · [\d,]+ total card points$/);
    expect(page().textContent).not.toContain('Brainrot Score');

    expandAll();
    expect(headers().every((h) => h.getAttribute('aria-expanded') === 'true')).toBe(true);
    expect(mountedPockets()).toBe(unboundedPockets(collection));
    const labels = tiles().map((tile) => tile.getAttribute('aria-label'));
    expect(labels).toHaveLength(owned.length);

    for (const set of SETS) {
      const cards = getSetCards(set.id);
      const have = cards.filter((card) => collection[card.key]);
      const header = headerOf(set.name);
      // The count reads "5/12 collected" to a screen reader; the word is visually hidden.
      expect(header.querySelector('.collection-set-count')!.textContent).toBe(`${have.length}/${cards.length} collected`);
      expect(header.querySelector('.collection-set-count .sr-only')!.textContent).toBe(' collected');
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
    expect(page().querySelector('.collection-empty')!.textContent).toBe('Open packs to start your collection.');
    expect(page().querySelectorAll('.collection-later li')).toHaveLength(SETS.filter(isOpenable).length);
  });
});

describe('completed sets', () => {
  const set = () => SETS.find(isOpenable)!;
  const cardsOf = () => getSetCards(set().id);
  const tag = () => headerOf(set().name).querySelector('.set-badge')?.textContent ?? null;
  /** Every card owned, as holos only when `holo` says so. */
  const ownAll = (holo: (index: number) => boolean) =>
    Object.fromEntries(cardsOf().map((card, i) => [card.key, { card, normalCount: 1, holoCount: holo(i) ? 1 : 0 } satisfies CollectionItem]));

  it('shows no tag while a card is missing', () => {
    render(own(cardsOf(), (i) => i === 0));
    expect(tag()).toBeNull();
  });

  it('says Complete once every card is owned in any version', () => {
    render(ownAll((i) => i === 0));
    expect(tag()).toBe('Complete');
    expect(headerOf(set().name).textContent).toContain('Complete');
  });

  it('says Master once every card is owned as a holo', () => {
    render(ownAll(() => true));
    expect(tag()).toBe('Master');
    expect(headerOf(set().name).textContent).not.toContain('Complete');
  });

  it('puts the meaning in the toggle\'s accessible text, and uses the foil badge for Master', () => {
    render(ownAll(() => true));
    expect(headerOf(set().name).querySelector('.set-badge--master')).not.toBeNull();
    expect(headerOf(set().name).textContent).toContain('Master: every card as a holo');
    render(ownAll((i) => i === 0));
    expect(headerOf(set().name).querySelector('.set-badge--complete')).not.toBeNull();
    expect(headerOf(set().name).textContent).toContain('Complete: every card collected');
  });

  it('shows the tag beside Archived on an archived set\'s header', () => {
    const archived = SETS.find((s) => s.archivedAt)!;
    render(Object.fromEntries(getSetCards(archived.id).map((card) => [card.key, { card, normalCount: 1, holoCount: 0 } satisfies CollectionItem])));
    const era = headerOf(archived.name).querySelector('.collection-set-era')!;
    expect(era.querySelector('.collection-set-archived')?.textContent).toBe('Archived');
    expect(era.querySelector('.set-badge')?.textContent).toBe('Complete');
  });

  it('still toggles from the header with the tag in it', () => {
    render(ownAll(() => true));
    const header = headerOf(set().name);
    const was = header.getAttribute('aria-expanded');
    header.focus();
    act(() => header.click());
    expect(header.getAttribute('aria-expanded')).not.toBe(was);
    expect(document.activeElement).toBe(header);
    expect(tag()).toBe('Master');
  });
});

describe('zero-copy records (#812)', () => {
  it('does not treat zero-copy entries as owned or completed, and renders uncollected slots', () => {
    const set = SETS.find(isOpenable)!;
    const cards = getSetCards(set.id);
    const zeroCollection: Record<string, CollectionItem> = Object.fromEntries(
      cards.map((card) => [card.key, { card, normalCount: 0, holoCount: 0 } satisfies CollectionItem]),
    );
    render(zeroCollection);

    expect(page().querySelector('.page-subtitle')?.textContent).toContain(`0/${COLLECTIBLE_CARDS.length} cards`);
    expect(page().querySelector('.page-subtitle')?.textContent).toContain('0 total card points');

    // With zero owned cards, the set is not started; it appears in the unstarted eras section
    expect(page().querySelector('.collection-empty')?.textContent).toContain('Open packs to start your collection.');
    const laterItem = [...page().querySelectorAll('.collection-later li')].find((li) =>
      li.querySelector('.collection-later-name')?.textContent === set.name,
    );
    expect(laterItem).toBeDefined();
    expect(laterItem?.querySelector('.collection-later-count')?.textContent).toBe(`0/${cards.length}`);
    expect(page().querySelectorAll('button.collection-item').length).toBe(0);
  });

  it('keeps positive controls owned alongside zero-copy entries and renders zero-copy slots as uncollected', () => {
    const set = SETS.find(isOpenable)!;
    const cards = getSetCards(set.id);
    const mixedCollection: Record<string, CollectionItem> = {
      [cards[0].key]: { card: cards[0], normalCount: 1, holoCount: 0 },
      [cards[1].key]: { card: cards[1], normalCount: 0, holoCount: 0 },
    };
    render(mixedCollection);

    expect(page().querySelector('.page-subtitle')?.textContent).toContain(`1/${COLLECTIBLE_CARDS.length} cards`);
    const header = headerOf(set.name);
    expect(header.textContent).toContain(`1/${cards.length}`);
    expect(header.querySelector('.set-badge')).toBeNull();

    const grid = gridOf(header)!;
    const itemButtons = grid.querySelectorAll('button.collection-item');
    expect(itemButtons.length).toBe(1);
    expect(itemButtons[0].getAttribute('aria-label')).toContain('1 owned');

    // The zero-copy card renders as an uncollected slot, not a button
    const slots = grid.querySelectorAll('.collection-slot');
    expect(slots.length).toBeGreaterThan(0);
  });
});

describe('collection search and filters (#756)', () => {
  const searchInput = () => page().querySelector<HTMLInputElement>('input#collection-search')!;
  const raritySelect = () => page().querySelector<HTMLSelectElement>('select#collection-rarity-filter')!;
  const finishSelect = () => page().querySelector<HTMLSelectElement>('select#collection-finish-filter')!;
  const holoButton = () => [...page().querySelectorAll<HTMLButtonElement>('.collection-pill-btn')].find((b) => b.textContent?.includes('Holo only'))!;
  const missingButton = () => [...page().querySelectorAll<HTMLButtonElement>('.collection-pill-btn')].find((b) => b.textContent?.includes('Missing only'))!;
  const clearButton = () => page().querySelector<HTMLButtonElement>('.collection-reset-btn');
  const searchClear = () => page().querySelector<HTMLButtonElement>('.collection-search-clear');

  const typeSearch = (value: string) => {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(searchInput(), value);
      searchInput().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  it('filters cards by name search and clears search via the clear button', () => {
    const set = SETS.find(isOpenable)!;
    const cards = getSetCards(set.id);
    const target = cards[0];
    render(own(cards));

    // Initially all cards in the open era are visible
    expect(tiles().length).toBeGreaterThan(1);

    // Type target card name substring
    const query = target.name.slice(0, 4);
    typeSearch(query);

    const matchingTiles = tiles();
    expect(matchingTiles.length).toBeGreaterThanOrEqual(1);
    expect(matchingTiles.every((tile) => tile.getAttribute('aria-label')?.toLowerCase().includes(query.toLowerCase()))).toBe(true);
    expect(page().querySelector('.collection-filter-status')?.textContent).toContain('Showing');

    // Click clear search button
    expect(searchClear()).not.toBeNull();
    act(() => searchClear()!.click());

    expect(searchInput().value).toBe('');
    expect(page().querySelector('.collection-filter-status')).toBeNull();
  });

  it('filters cards by rarity', () => {
    const set = SETS.find(isOpenable)!;
    const cards = getSetCards(set.id);
    render(own(cards));

    act(() => {
      raritySelect().value = 'RARE';
      raritySelect().dispatchEvent(new Event('change', { bubbles: true }));
    });

    const currentTiles = tiles();
    expect(currentTiles.length).toBeGreaterThan(0);
    expect(currentTiles.every((tile) => tile.classList.contains('rare'))).toBe(true);

    // Reset filters
    act(() => clearButton()!.click());
    expect(raritySelect().value).toBe('ALL');
  });

  it('filters cards by holo only', () => {
    const set = SETS.find(isOpenable)!;
    const cards = getSetCards(set.id);
    // Card 0 is holo, card 1 is non-holo
    const collection: Record<string, CollectionItem> = {
      [cards[0].key]: { card: cards[0], normalCount: 0, holoCount: 1 },
      [cards[1].key]: { card: cards[1], normalCount: 2, holoCount: 0 },
    };
    render(collection);

    expect(holoButton().getAttribute('aria-pressed')).toBe('false');
    act(() => holoButton().click());

    expect(holoButton().getAttribute('aria-pressed')).toBe('true');
    const currentTiles = tiles();
    expect(currentTiles.length).toBe(1);
    expect(currentTiles[0].getAttribute('aria-label')).toContain(cards[0].name);
    expect(currentTiles[0].classList.contains('holo')).toBe(true);
  });

  it('filters cards by finish', () => {
    const set = SETS.find(isOpenable)!;
    const cards = getSetCards(set.id);
    const collection: Record<string, CollectionItem> = {
      [cards[0].key]: { card: cards[0], normalCount: 1, holoCount: 0, finishes: { GOLD: 1 } },
      [cards[1].key]: { card: cards[1], normalCount: 1, holoCount: 0, finishes: { SILVER: 1 } },
      [cards[2].key]: { card: cards[2], normalCount: 1, holoCount: 0 },
    };
    render(collection);

    // Filter to any finish
    act(() => {
      finishSelect().value = 'ANY';
      finishSelect().dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(tiles().length).toBe(2);

    // Filter to Gold only
    act(() => {
      finishSelect().value = 'GOLD';
      finishSelect().dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(tiles().length).toBe(1);
    expect(tiles()[0].getAttribute('aria-label')).toContain('Gold');
  });

  it('filters to missing cards only', () => {
    const set = SETS.find(isOpenable)!;
    const cards = getSetCards(set.id);
    // Own only the first card of the set
    const collection: Record<string, CollectionItem> = {
      [cards[0].key]: { card: cards[0], normalCount: 1, holoCount: 0 },
    };
    render(collection);

    expect(missingButton().getAttribute('aria-pressed')).toBe('false');
    act(() => missingButton().click());

    expect(missingButton().getAttribute('aria-pressed')).toBe('true');
    // Only uncollected slots should be rendered in the grid, owned tile button should be hidden
    expect(tiles().length).toBe(0);
    const slots = page().querySelectorAll('.collection-slot');
    expect(slots.length).toBe(cards.length - 1);
  });

  it('displays empty message when no cards match filters and allows reset', () => {
    const set = SETS.find(isOpenable)!;
    const cards = getSetCards(set.id);
    render(own(cards));

    typeSearch('ThisNameDoesNotExistInAnySet12345');

    expect(page().querySelector('.collection-empty-filter')).not.toBeNull();
    expect(page().querySelector('.collection-empty-filter')?.textContent).toContain('No cards match the active filters.');

    // Click reset in the empty state
    const reset = page().querySelector<HTMLButtonElement>('.collection-empty-filter .collection-reset-btn')!;
    act(() => reset.click());

    expect(page().querySelector('.collection-empty-filter')).toBeNull();
    expect(tiles().length).toBeGreaterThan(0);
  });
});
