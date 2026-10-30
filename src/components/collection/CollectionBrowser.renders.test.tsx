// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardPoints, getSetCards } from '../../data/cards';
import { isOpenable, SETS } from '../../content/sets';
import type { CollectionItem } from '../../types';
import { getAccountValue } from '../../utils/achievementChecks';
import { hydrateCollection } from '../../utils/migrations';
import CollectionBrowser from './CollectionBrowser';

const { tileRenders } = vi.hoisted(() => ({ tileRenders: [] as string[] }));
// A stand-in for the tile art that records each render by image, so a test can tell which era's tiles rendered.
vi.mock('../cards/CardImage', () => ({
  default: ({ src, thumbnail }: { src: string; thumbnail?: boolean }) => {
    if (thumbnail) tileRenders.push(src);
    return null;
  },
}));
// jsdom has no canvas and the viewer is not under test.
vi.mock('../cards/CardViewerModal', () => ({ default: () => null }));

/** Every openable era started, with a few cards owned in each. */
const ERAS = SETS.filter(isOpenable);
const ownedIn = (setId: string): Record<string, CollectionItem> =>
  Object.fromEntries(getSetCards(setId).slice(0, 3).map((card) => [card.key, { card, normalCount: 1, holoCount: 0 } satisfies CollectionItem]));
const collection = Object.assign({}, ...ERAS.map((set) => ownedIn(set.id)));

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  tileRenders.length = 0;
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  // The first era (the recent one) opens with the page; the others start collapsed.
  act(() => root.render(<CollectionBrowser collection={collection} recentSetId={ERAS[0].id} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const tilesOf = (setId: string) => {
  const images = new Set(getSetCards(setId).map((card) => card.image));
  return tileRenders.filter((src) => images.has(src)).length;
};
const toggleButton = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('.collection-set-toggle')].find((b) => b.textContent?.includes(name))!;
const isOpen = (setId: string) => toggleButton(SETS.find((set) => set.id === setId)!.name).getAttribute('aria-expanded') === 'true';
const toggle = (setId: string) => {
  const button = toggleButton(SETS.find((set) => set.id === setId)!.name);
  act(() => button.click());
};

describe('CollectionBrowser renders', () => {
  // The page opens the recent era and as many more as fit its tile budget; the rest start collapsed.
  const opened = () => ERAS.filter((set) => isOpen(set.id));
  const closed = () => ERAS.filter((set) => !isOpen(set.id));

  it('starts with the recent era open and at least two others collapsed', () => {
    expect(isOpen(ERAS[0].id)).toBe(true);
    expect(closed().length).toBeGreaterThanOrEqual(2);
    expect(tilesOf(ERAS[0].id)).toBeGreaterThan(0);
  });

  it('opening another era renders only that era', () => {
    const [next, later] = closed();
    toggle(next.id);
    tileRenders.length = 0;
    toggle(later.id);

    expect(tilesOf(later.id)).toBeGreaterThan(0);
    for (const set of opened().filter((s) => s.id !== later.id)) expect(tilesOf(set.id), set.id).toBe(0);
  });

  it('closing an era renders no other era', () => {
    toggle(closed()[0].id);
    tileRenders.length = 0;
    toggle(ERAS[0].id);

    expect(tileRenders).toEqual([]);
  });

  it('a changed collection renders the open era it changed', () => {
    tileRenders.length = 0;
    const [firstKey] = Object.keys(ownedIn(ERAS[0].id));
    const changed = { ...collection, [firstKey]: { ...collection[firstKey], normalCount: 2 } };
    act(() => root.render(<CollectionBrowser collection={changed} recentSetId={ERAS[0].id} />));

    expect(tilesOf(ERAS[0].id)).toBeGreaterThan(0);
  });

  it('tapping a card renders no era again', () => {
    toggle(closed()[0].id);
    tileRenders.length = 0;
    act(() => container.querySelector<HTMLButtonElement>('.collection-item')!.click());

    expect(tileRenders).toEqual([]);
  });
});

describe('CollectionBrowser after loading a save with bad counts (#1109)', () => {
  it('shows the repaired copies, and its score matches the achievement score', () => {
    const [card, other] = getSetCards(ERAS[0].id);
    const loaded = hydrateCollection(JSON.parse(JSON.stringify({
      [card.key]: { card: { id: card.id, key: card.key }, normalCount: -3, holoCount: 2 },
      [other.key]: { card: { id: other.id, key: other.key }, normalCount: -3, holoCount: -1 },
    }))) as Record<string, CollectionItem>;
    act(() => root.render(<CollectionBrowser collection={loaded} recentSetId={ERAS[0].id} />));

    const tiles = [...container.querySelectorAll<HTMLButtonElement>('.collection-item')];
    expect(tiles.map((tile) => tile.querySelector('.collection-count')?.textContent)).toEqual(['×2']);
    const score = getAccountValue(loaded);
    expect(score).toBe(2 * cardPoints(card.rarity, true));
    expect(container.textContent).toContain(`${score.toLocaleString()} total card points`);
  });
});
