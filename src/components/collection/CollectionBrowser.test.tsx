// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS, CARD_RARITIES, COLLECTIBLE_CARDS, getSetCards, type Card } from '../../data/cards';
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

  it('shows holo completion percentage in the binder header and progress bar when holos are owned', () => {
    // 3 of 12 cards as holo = 25% holo
    render(ownAll((i) => i < 3));
    const header = headerOf(set().name);
    const holoPct = header.querySelector('.collection-set-holo-pct');
    expect(holoPct?.textContent).toBe('25% holo');
    expect(holoPct?.getAttribute('title')).toBe(`3 of ${cardsOf().length} cards collected as holo`);
    const holoBar = header.closest('.collection-set-header')?.querySelector('.collection-set-bar-holo');
    expect(holoBar).not.toBeNull();
    expect(holoBar?.getAttribute('style')).toContain('width: 25%');
  });

  it('hides the holo percentage badge when the set reaches Master status', () => {
    render(ownAll(() => true));
    const header = headerOf(set().name);
    expect(header.querySelector('.collection-set-holo-pct')).toBeNull();
    expect(header.querySelector('.set-badge--master')?.textContent).toBe('Master');
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
  const searchInput = () => page().querySelector<HTMLInputElement>('input[type="search"]')!;
  const select = (label: string) => page().querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  const toggle = (name: string) => [...page().querySelectorAll<HTMLButtonElement>('.collection-pill-btn')].find((b) => b.textContent === name)!;
  const clearFilters = () => page().querySelector<HTMLButtonElement>('.collection-filter-row .collection-reset-btn');
  const status = () => page().querySelector('[role="status"]')!.textContent;
  const names = () => tiles().map((tile) => tile.getAttribute('aria-label')!.split(',')[0]);
  const slotCount = () => page().querySelectorAll('.collection-slot').length;
  const holoPct = () => page().querySelector('.collection-set-holo-pct')?.textContent;

  const typeSearch = (value: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(searchInput(), value);
    searchInput().dispatchEvent(new Event('input', { bubbles: true }));
  });
  const choose = (label: string, value: string) => act(() => {
    select(label).value = value;
    select(label).dispatchEvent(new Event('change', { bubbles: true }));
  });
  const press = (name: string) => act(() => toggle(name).click());

  /** One openable era with a known spread: card 0 plain, 1 holo, 2 gold, 3 silver + holo. The rest missing. */
  const mixed = () => {
    const set = SETS.find(isOpenable)!;
    const cards = getSetCards(set.id);
    const collection: Record<string, CollectionItem> = {
      [cards[0].key]: { card: cards[0], normalCount: 2, holoCount: 0 },
      [cards[1].key]: { card: cards[1], normalCount: 0, holoCount: 1 },
      [cards[2].key]: { card: cards[2], normalCount: 1, holoCount: 0, finishes: { GOLD: 1 } },
      [cards[3].key]: { card: cards[3], normalCount: 1, holoCount: 1, finishes: { SILVER: 1 } },
    };
    return { set, cards, collection };
  };

  it('searches by name in any case and clears with the button, handing focus back to the box', () => {
    const { cards, collection } = mixed();
    render(collection);
    expect(tiles()).toHaveLength(4);
    typeSearch(`  ${cards[2].name.slice(0, 5).toUpperCase()} `);
    expect(names()).toContain(cards[2].name);
    expect(names().every((name) => name.toLowerCase().includes(cards[2].name.slice(0, 5).toLowerCase()))).toBe(true);
    expect(status()).toMatch(/^Showing \d+ cards?/);
    const clear = page().querySelector<HTMLButtonElement>('.collection-search-clear')!;
    expect(clear.getAttribute('aria-label')).toBe('Clear search');
    act(() => clear.click());
    expect(searchInput().value).toBe('');
    expect(document.activeElement).toBe(searchInput());
    expect(page().querySelector('.collection-search-clear')).toBeNull();
    expect(tiles()).toHaveLength(4);
    expect(status()).toBe('');
  });

  it('a blank search is not a filter', () => {
    render(mixed().collection);
    typeSearch('   ');
    expect(tiles()).toHaveLength(4);
    expect(status()).toBe('');
    expect(clearFilters()).toBeNull();
  });

  it('filters by rarity', () => {
    const { cards, collection } = mixed();
    const rarity = cards[0].rarity;
    render(collection);
    choose('Filter by rarity', rarity);
    const expected = [0, 1, 2, 3].filter((i) => cards[i].rarity === rarity).map((i) => cards[i].name);
    expect(names()).toEqual(expected);
    expect(tiles().every((tile) => tile.classList.contains(rarity.toLowerCase()))).toBe(true);
  });

  it('filters by holo only, counting a card with any holo copy', () => {
    const { cards, collection } = mixed();
    render(collection);
    press('Holo only');
    expect(toggle('Holo only').getAttribute('aria-pressed')).toBe('true');
    expect(names()).toEqual([cards[1].name, cards[3].name]);
    press('Holo only');
    expect(tiles()).toHaveLength(4);
  });

  it('filters by any finish and by one finish', () => {
    const { cards, collection } = mixed();
    render(collection);
    choose('Filter by finish', 'ANY');
    expect(names()).toEqual([cards[2].name, cards[3].name]);
    choose('Filter by finish', 'GOLD');
    expect(names()).toEqual([cards[2].name]);
    choose('Filter by finish', 'DIAMOND');
    expect(tiles()).toHaveLength(0);
    expect(status()).toBe('No cards match the active filters.');
  });

  it('lists only missing cards as empty pockets with Not found yet', () => {
    const { cards, collection } = mixed();
    render(collection);
    expect(slotCount()).toBe(cards.length - 4);
    choose('Show cards', 'NOT_FOUND_YET');
    expect(select('Show cards').value).toBe('NOT_FOUND_YET');
    expect(tiles()).toHaveLength(0);
    expect(slotCount()).toBe(cards.length - 4);
    expect(status()).toMatch(new RegExp(`^Showing ${cards.length - 4} cards`));
  });

  it('lists only owned cards with Show: Owned, hiding empty slots and resetting on Clear filters', () => {
    const { cards, collection } = mixed();
    render(collection);
    expect(tiles()).toHaveLength(4);
    expect(slotCount()).toBe(cards.length - 4);

    choose('Show cards', 'OWNED');
    expect(select('Show cards').value).toBe('OWNED');
    expect(tiles()).toHaveLength(4);
    expect(slotCount()).toBe(0);
    expect(status()).toBe('Showing 4 cards');

    // Switching to Not found yet shows missing cards
    choose('Show cards', 'NOT_FOUND_YET');
    expect(select('Show cards').value).toBe('NOT_FOUND_YET');
    expect(tiles()).toHaveLength(0);
    expect(slotCount()).toBe(cards.length - 4);

    // Switching back to Owned shows owned cards
    choose('Show cards', 'OWNED');
    expect(select('Show cards').value).toBe('OWNED');
    expect(tiles()).toHaveLength(4);
    expect(slotCount()).toBe(0);

    // Clear filters resets Show to ALL
    act(() => clearFilters()!.click());
    expect(select('Show cards').value).toBe('ALL');
    expect(tiles()).toHaveLength(4);
    expect(slotCount()).toBe(cards.length - 4);
  });

  it('Showing N cards counts matches only inside expanded eras (#756)', () => {
    const [first, second] = SETS.filter(isOpenable);
    const firstCards = getSetCards(first.id);
    const secondCards = getSetCards(second.id);
    // Own 2 cards from first era, 2 cards from second era
    const collection = own([firstCards[0], firstCards[1], secondCards[0], secondCards[1]]);
    render(collection);

    // Filter to only owned cards
    choose('Show cards', 'OWNED');
    const firstHeader = headerOf(first.name);
    const secondHeader = headerOf(second.name);
    expect(firstHeader.getAttribute('aria-expanded')).toBe('true');
    expect(secondHeader.getAttribute('aria-expanded')).toBe('true');
    expect(status()).toBe('Showing 4 cards');

    // Collapse the first era: its 2 cards are hidden, so status says Showing 2 cards
    act(() => firstHeader.click());
    expect(firstHeader.getAttribute('aria-expanded')).toBe('false');
    expect(status()).toBe('Showing 2 cards');

    // Collapse the second era too: 0 cards showing
    act(() => secondHeader.click());
    expect(secondHeader.getAttribute('aria-expanded')).toBe('false');
    expect(status()).toBe('Showing 0 cards');

    // Re-expand first era
    act(() => firstHeader.click());
    expect(firstHeader.getAttribute('aria-expanded')).toBe('true');
    expect(status()).toBe('Showing 2 cards');
  });

  describe('sort options (#756)', () => {
    it('defaults to set order', () => {
      const { cards, collection } = mixed();
      render(collection);
      expect(select('Sort cards').value).toBe('set');
      expect(names().slice(0, 4)).toEqual([cards[0].name, cards[1].name, cards[2].name, cards[3].name]);
    });

    it('sorts within each era by rarity (rarest first), keeping eras in their original order', () => {
      const [firstSet, secondSet] = SETS.filter(isOpenable);
      const firstCards = getSetCards(firstSet.id);
      const secondCards = getSetCards(secondSet.id);
      const firstCommon = firstCards.find((c) => c.rarity === 'COMMON')!;
      const firstRare = firstCards.find((c) => c.rarity === 'LEGENDARY' || c.rarity === 'EPIC')!;
      const secondCommon = secondCards.find((c) => c.rarity === 'COMMON')!;
      const secondRare = secondCards.find((c) => c.rarity === 'LEGENDARY' || c.rarity === 'EPIC')!;

      const collection: Record<string, CollectionItem> = {
        [firstCommon.key]: { card: firstCommon, normalCount: 1, holoCount: 0 },
        [firstRare.key]: { card: firstRare, normalCount: 1, holoCount: 0 },
        [secondCommon.key]: { card: secondCommon, normalCount: 1, holoCount: 0 },
        [secondRare.key]: { card: secondRare, normalCount: 1, holoCount: 0 },
      };
      render(collection);
      choose('Sort cards', 'rarity');

      // Eras maintain their order
      expect(headers().map(nameOf)).toEqual([firstSet.name, secondSet.name]);
      // First era: rarer card before common card
      const firstTiles = tiles(gridOf(headerOf(firstSet.name))!);
      expect(firstTiles.map((t) => t.getAttribute('aria-label')!.split(',')[0])).toEqual([firstRare.name, firstCommon.name]);
      // Second era: rarer card before common card
      const secondTiles = tiles(gridOf(headerOf(secondSet.name))!);
      expect(secondTiles.map((t) => t.getAttribute('aria-label')!.split(',')[0])).toEqual([secondRare.name, secondCommon.name]);
    });

    it('sorts within each era by count (most copies first), ties falling back to set order', () => {
      const { cards } = mixed();
      const collection: Record<string, CollectionItem> = {
        [cards[0].key]: { card: cards[0], normalCount: 1, holoCount: 0 }, // 1 copy
        [cards[1].key]: { card: cards[1], normalCount: 5, holoCount: 2 }, // 7 copies
        [cards[2].key]: { card: cards[2], normalCount: 3, holoCount: 0 }, // 3 copies
        [cards[3].key]: { card: cards[3], normalCount: 3, holoCount: 0 }, // 3 copies (tie with cards[2])
      };
      render(collection);
      choose('Sort cards', 'count');
      expect(names().slice(0, 4)).toEqual([cards[1].name, cards[2].name, cards[3].name, cards[0].name]);
    });

    it('sorts within each era by points (highest first)', () => {
      const { set } = mixed();
      const cards = getSetCards(set.id);
      const collection: Record<string, CollectionItem> = {
        [cards[0].key]: { card: { ...cards[0], rarity: 'COMMON' }, normalCount: 1, holoCount: 0 }, // 10 pts
        [cards[1].key]: { card: { ...cards[1], rarity: 'LEGENDARY' }, normalCount: 1, holoCount: 0 }, // 250 pts
        [cards[2].key]: { card: { ...cards[2], rarity: 'COMMON' }, normalCount: 100, holoCount: 0 }, // 1000 pts
      };
      render(collection);
      choose('Sort cards', 'points');
      expect(names().slice(0, 3)).toEqual([cards[2].name, cards[1].name, cards[0].name]);
    });

    it('keeps sort choice in component state only, not saved to storage', () => {
      const { collection } = mixed();
      render(collection);
      choose('Sort cards', 'rarity');
      expect(select('Sort cards').value).toBe('rarity');
      remount();
      render(collection);
      expect(select('Sort cards').value).toBe('set');
    });
  });

  it('combines filters, every one narrowing the result', () => {
    const { cards, collection } = mixed();
    render(collection);
    press('Holo only');
    choose('Filter by finish', 'ANY');
    expect(names()).toEqual([cards[3].name]);
    typeSearch(cards[2].name);
    expect(tiles()).toHaveLength(0);
    typeSearch(cards[3].name);
    expect(names()).toEqual([cards[3].name]);
    // Holo only, finish and Not found yet together can match nothing: a card can't be both.
    choose('Show cards', 'NOT_FOUND_YET');
    expect(tiles()).toHaveLength(0);
    expect(status()).toBe('No cards match the active filters.');
    expect(page().querySelector('.collection-empty-filter')?.textContent).toContain('Cards not found yet cannot be holo or have a finish.');
    expect(page().querySelector('.collection-empty-filter button')?.textContent).toBe('Clear filters');
    // Clicking the empty state's Clear filters resets the filters
    act(() => page().querySelector<HTMLButtonElement>('.collection-empty-filter button')?.click());
    expect(select('Show cards').value).toBe('ALL');
    expect(toggle('Holo only').getAttribute('aria-pressed')).toBe('false');
    expect(tiles()).toHaveLength(4);
  });

  it('shows an empty result with a reset that restores the binder and moves focus to the search box', () => {
    const { collection } = mixed();
    render(collection);
    typeSearch('zzz no card is named this');
    choose('Filter by rarity', 'LEGENDARY');
    expect(status()).toBe('No cards match the active filters.');
    expect(headers()).toHaveLength(0);
    expect(page().querySelector('.collection-empty-filter')).not.toBeNull();
    // One reset button, not two with the same name.
    expect(page().querySelectorAll('.collection-reset-btn')).toHaveLength(1);
    act(() => clearFilters()!.click());
    expect(page().querySelector('.collection-empty-filter')).toBeNull();
    expect(searchInput().value).toBe('');
    expect(select('Filter by rarity').value).toBe('ALL');
    expect(select('Filter by finish').value).toBe('ALL');
    expect(toggle('Holo only').getAttribute('aria-pressed')).toBe('false');
    expect(tiles()).toHaveLength(4);
    expect(document.activeElement).toBe(searchInput());
    expect(status()).toBe('');
  });

  it('keeps collector numbers, set progress and the score line as the unfiltered binder shows them', () => {
    const { cards, collection } = mixed();
    render(collection);
    const count = headers()[0].querySelector('.collection-set-count')!.textContent;
    const subtitle = page().querySelector('.page-subtitle')!.textContent;
    const pct = holoPct();
    const numberOf = (card: Card) => `${String(cards.indexOf(card) + 1).padStart(3, '0')}/${String(cards.length).padStart(3, '0')}`;
    expect(pct).toBeDefined();
    typeSearch(cards[3].name);
    expect(headers()[0].querySelector('.collection-set-count')!.textContent).toBe(count);
    expect(page().querySelector('.page-subtitle')!.textContent).toBe(subtitle);
    expect(holoPct()).toBe(pct);
    expect(tiles()[0].getAttribute('aria-label')).toContain(numberOf(cards[3]));
    expect(page().querySelector('.collection-grid .collection-label')!.textContent).toContain(numberOf(cards[3]));
    // A missing pocket keeps the number it has in the full binder, not one counted from the filtered list.
    typeSearch('');
    choose('Show cards', 'NOT_FOUND_YET');
    const last = cards[cards.length - 1];
    expect([...page().querySelectorAll('.collection-grid > li')].map((li) => li.getAttribute('aria-label'))).toContain(
      `${numberOf(last)}, ${CARD_RARITIES[last.rarity].name}, not collected yet`,
    );
    expect(headers()[0].querySelector('.collection-set-count')!.textContent).toBe(count);
  });

  it('opens a collapsed era that has matches and lets you collapse it again while filtering', () => {
    const { collection } = mixed();
    render(collection);
    act(() => headers()[0].click());
    expect(openEras()).toEqual([]);
    typeSearch('a');
    expect(openEras().length).toBeGreaterThan(0);
    act(() => headers()[0].click());
    expect(openEras()).toEqual([]);
    act(() => clearFilters()!.click());
    expect(openEras()).toEqual([]);
  });

  describe('keeps the opening budget while filtering (#344)', () => {
    it('opens the matching eras newest first until 24 pockets, and the rest open on demand', () => {
      const collection = own(SETS.flatMap((set) => getSetCards(set.id)));
      render(collection);
      const unfilteredOpen = openEras();
      typeSearch('a');
      const matching = headers();
      expect(matching.length).toBeGreaterThan(unfilteredOpen.length);
      expect(mountedPockets()).toBeLessThanOrEqual(24);
      expect(openEras().length).toBeGreaterThan(0);
      expect(openEras().length).toBeLessThan(matching.length);
      // A collapsed matching era opens on demand and shows only its own matches.
      const closed = headers().find((h) => h.getAttribute('aria-expanded') === 'false')!;
      const before = mountedPockets();
      act(() => closed.click());
      expect(closed.getAttribute('aria-expanded')).toBe('true');
      expect(mountedPockets()).toBeGreaterThan(before);
      act(() => closed.click());
      expect(closed.getAttribute('aria-expanded')).toBe('false');
      expect(mountedPockets()).toBe(before);
    });

    it('always opens the first matching era even when it alone is over the budget', () => {
      addFutureSets(2, 30);
      render(own(SETS.slice(-2).flatMap((set) => getSetCards(set.id))));
      typeSearch('card');
      expect(openEras()).toEqual(['Future era 2']);
      expect(mountedPockets()).toBe(30);
      expect(headerOf('Future era 1').getAttribute('aria-expanded')).toBe('false');
    });

    it('keeps the bound for a future-growth collection of 40 eras, without finish work for collapsed ones', () => {
      addFutureSets();
      render(own(SETS.flatMap((set) => getSetCards(set.id))));
      typeSearch('card');
      // Every future card matches ("... card N"): 40 eras of matches, two eras' worth of pockets.
      expect(headers().length).toBeGreaterThanOrEqual(FUTURE_SETS);
      expect(openEras()).toEqual([`Future era ${FUTURE_SETS - 1}`, `Future era ${FUTURE_SETS}`]);
      expect(mountedPockets()).toBe(24);
      expect(holdFinishedCardImage).toHaveBeenCalledTimes(finishedTiles());
      // Leaving the filter returns to the unfiltered opening budget.
      act(() => clearFilters()!.click());
      expect(mountedPockets()).toBe(24);
    });

    it('opens the recent era first while filtering even when newer matching eras would spend the budget (#344)', () => {
      addFutureSets(3, 12);
      const future1 = setNamed('Future era 1');
      const future2 = setNamed('Future era 2');
      const future3 = setNamed('Future era 3');
      const collection = own([...getSetCards(future1.id), ...getSetCards(future2.id), ...getSetCards(future3.id)]);

      render(collection);
      typeSearch('card');
      // Without recentSetId, the newest eras future-2 (12) + future-3 (12) = 24 fill the budget; future-1 is collapsed.
      expect(openEras()).toEqual([future2.name, future3.name]);

      remount();
      render(collection, future1.id);
      typeSearch('card');
      // With future-1 as recentSetId, future-1 (12) opens first, then future-3 (12) fills the budget; future-2 is collapsed.
      expect(openEras()).toEqual([future1.name, future3.name]);
      expect(headerOf(future2.name).getAttribute('aria-expanded')).toBe('false');
      expect(mountedPockets()).toBe(24);
    });

    it('counts matching pockets rather than whole eras against the budget while filtering (#344)', () => {
      // 3 eras with 30 cards each. Each whole era is 30 cards, larger than the 24 budget.
      addFutureSets(3, 30);
      const sets = [setNamed('Future era 1'), setNamed('Future era 2'), setNamed('Future era 3')];
      const collection = own(sets.flatMap((s) => getSetCards(s.id)));

      render(collection);
      // 'card 30' matches only card 30 in each of the 3 eras (1 pocket per era = 3 matching pockets total <= 24)
      typeSearch('card 30');
      // All 3 eras open because matching pockets (1 per era) are counted instead of whole eras (30 per era)
      expect(openEras()).toEqual([sets[0].name, sets[1].name, sets[2].name]);
      expect(mountedPockets()).toBe(3);
    });
  });

  it('hides eras with no match', () => {
    const openable = SETS.filter(isOpenable);
    const older = openable[0];
    const newer = openable[openable.length - 1];
    const olderCard = getSetCards(older.id)[0];
    const newerCard = getSetCards(newer.id)[0];
    render({
      [olderCard.key]: { card: olderCard, normalCount: 1, holoCount: 0 },
      [newerCard.key]: { card: newerCard, normalCount: 1, holoCount: 0 },
    });
    expect(headers().map(nameOf)).toEqual([older.name, newer.name]);
    typeSearch(newerCard.name);
    expect(headers().map(nameOf)).toEqual([newer.name]);
    expect(names()).toEqual([newerCard.name]);
  });

  describe('never shows more than the unfiltered binder', () => {
    it('Missing only lists no pocket of an archived or draft era, and turning it off brings back the owned cards', () => {
      const archived = SETS.find((s) => s.archivedAt)!;
      const draftBase = SETS.find(isOpenable)!;
      const draft: SetDefinition = { ...draftBase, id: 'draft-test', name: 'Draft test', era: '2099', draft: true, archivedAt: undefined };
      const draftCards: Card[] = Array.from({ length: 4 }, (_, k) => ({
        key: `draft-test/c${k}`, setId: 'draft-test', id: `c${k}`, name: `Draftcard ${k}`, rarity: 'COMMON', image: `/draft/c${k}.webp`,
      }));
      SETS.push(draft);
      ALL_CARDS.push(...draftCards);
      COLLECTIBLE_CARDS.push(...draftCards);
      const archivedCards = getSetCards(archived.id);
      render({
        [archivedCards[0].key]: { card: archivedCards[0], normalCount: 1, holoCount: 0 },
        [draftCards[0].key]: { card: draftCards[0], normalCount: 1, holoCount: 0 },
      });
      // Unfiltered: only the owned card of each.
      expect(tiles()).toHaveLength(2);
      expect(slotCount()).toBe(0);
      choose('Show cards', 'NOT_FOUND_YET');
      expect(slotCount()).toBe(0);
      expect(tiles()).toHaveLength(0);
      expect(headers().map(nameOf)).not.toContain(archived.name);
      expect(headers().map(nameOf)).not.toContain(draft.name);
      expect(page().textContent).not.toContain('Draftcard');
      choose('Show cards', 'ALL');
      expect(tiles()).toHaveLength(2);
      expect(slotCount()).toBe(0);
    });

    it('searching by name does not find a card of an unstarted draft era', () => {
      const base = SETS.find(isOpenable)!;
      const draft: SetDefinition = { ...base, id: 'secret-draft', name: 'Secret draft', era: '2099', draft: true, archivedAt: undefined };
      const secret: Card = { key: 'secret-draft/x', setId: 'secret-draft', id: 'x', name: 'Zzyzx Leak', rarity: 'COMMON', image: '/x.webp' };
      SETS.push(draft);
      ALL_CARDS.push(secret);
      COLLECTIBLE_CARDS.push(secret);
      render({});
      typeSearch('zzyzx');
      expect(page().textContent).not.toContain('Secret draft');
      expect(page().textContent).not.toContain('Zzyzx');
      expect(status()).toBe('No cards match the active filters.');
    });

    it('lists an era you have not started as a row with Not found yet, and no pockets', () => {
      const set = SETS.find(isOpenable)!;
      render({});
      choose('Show cards', 'NOT_FOUND_YET');
      expect(tiles()).toHaveLength(0);
      expect(slotCount()).toBe(0);
      const rows = [...page().querySelectorAll('.collection-later-name')].map((n) => n.textContent);
      expect(rows).toContain(set.name);
      expect(status()).toMatch(/^Showing 0 cards, and \d+ eras? not started$/);
    });
  });

  describe('keyboard and ARIA', () => {
    it('labels every control and exposes the toggles as pressed buttons in tab order', () => {
      render(mixed().collection);
      const search = page().querySelector('[role="search"]')!;
      expect(search.getAttribute('aria-label')).toBeTruthy();
      expect(searchInput().getAttribute('aria-label')).toBe('Search cards by name');
      expect(select('Sort cards').tagName).toBe('SELECT');
      expect(select('Show cards').tagName).toBe('SELECT');
      expect(select('Filter by rarity').tagName).toBe('SELECT');
      expect(select('Filter by finish').tagName).toBe('SELECT');
      expect(toggle('Holo only').tagName).toBe('BUTTON');
      expect(toggle('Holo only').getAttribute('type')).toBe('button');
      expect(toggle('Holo only').getAttribute('aria-pressed')).toBe('false');
      expect(toggle('Holo only').tabIndex).toBe(0);

      // Visible labels for Sort and Show
      expect(search.querySelector('label[for="collection-sort"]')?.textContent).toBe('Sort');
      expect(search.querySelector('label[for="collection-show"]')?.textContent).toBe('Show');

      const order = [...search.querySelectorAll<HTMLElement>('input, select, button')];
      expect(order.map((el) => el.getAttribute('aria-label') ?? el.textContent)).toEqual([
        'Search cards by name', 'Sort cards', 'Show cards', 'Filter by rarity', 'Filter by finish', 'Holo only',
      ]);
      expect(order.every((el) => el.tabIndex >= 0)).toBe(true);
    });

    it('offers every show, rarity and finish option by name, from the game data, and only those', () => {
      render(mixed().collection);
      const showOptions = [...select('Show cards').options].map((o) => o.textContent);
      expect(showOptions).toEqual(['All', 'Owned', 'Not found yet']);
      const rarities = [...select('Filter by rarity').options].map((o) => o.textContent);
      expect(rarities).toEqual(['All rarities', 'Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Brainrot']);
      const finishes = [...select('Filter by finish').options].map((o) => o.textContent);
      expect(finishes).toEqual(['All finishes', 'Any finish', 'Silver', 'Gold', 'Platinum', 'Diamond']);
    });

    it('announces the result in one always-present polite status, and not twice when nothing matches', () => {
      render(mixed().collection);
      const live = page().querySelector('[role="status"]')!;
      expect(live).not.toBeNull();
      expect(page().querySelectorAll('[role="status"]')).toHaveLength(1);
      typeSearch('zzz');
      expect(page().querySelector('[role="status"]')).toBe(live);
      expect(live.textContent).toBe('No cards match the active filters.');
      expect(page().querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(page().querySelector('.collection-empty-filter')!.textContent).not.toContain('No cards match');
    });

    it('shows Clear filters only while filtering and pressing it resets the toggles', () => {
      render(mixed().collection);
      expect(clearFilters()).toBeNull();
      press('Holo only');
      expect(clearFilters()).not.toBeNull();
      act(() => clearFilters()!.click());
      expect(toggle('Holo only').getAttribute('aria-pressed')).toBe('false');
      expect(clearFilters()).toBeNull();
    });

    it('keeps tiles reachable and named as buttons while filtered', () => {
      const { cards, collection } = mixed();
      render(collection);
      press('Holo only');
      for (const tile of tiles()) {
        expect(tile.tabIndex).toBe(0);
        expect(tile.getAttribute('aria-label')).toMatch(/holo/);
      }
      act(() => tiles()[0].click());
      expect(document.body.textContent).toContain(cards[1].name);
    });

    it('ignores collection items with missing card rarity in score sum and ownership map (#756)', () => {
      const { cards } = mixed();
      const corruptItem = {
        card: { key: 'corrupt/c1', name: 'No Rarity Card' },
        count: 5,
      } as unknown as CollectionItem;
      render({
        [cards[0].key]: { card: cards[0], normalCount: 1, holoCount: 0 },
        'corrupt/c1': corruptItem,
      });
      expect(page().querySelector('.page-subtitle')?.textContent).toContain('cards');
    });

    it('explains why filters cannot match and offers Clear filters when impossible (#756)', () => {
      const { collection } = mixed();
      render(collection);
      choose('Show cards', 'NOT_FOUND_YET');
      choose('Filter by finish', 'SILVER');
      expect(status()).toBe('No cards match the active filters.');
      const empty = page().querySelector('.collection-empty-filter')!;
      expect(empty.textContent).toContain('Cards not found yet cannot have a finish.');
      const reset = empty.querySelector<HTMLButtonElement>('button')!;
      expect(reset).not.toBeNull();
      expect(reset.textContent).toBe('Clear filters');
      act(() => reset.click());
      expect(select('Show cards').value).toBe('ALL');
      expect(select('Filter by finish').value).toBe('ALL');
      expect(tiles()).toHaveLength(4);
    });
  });
});
