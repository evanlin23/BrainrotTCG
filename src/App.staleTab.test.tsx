// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SET_ID, SETS } from './content/sets';
import { scoreCards } from './data/cards';
import { getPlayer } from './game/player';
import { savePendingPack, toCardsWithMeta, type OpenedPack } from './game/pulls';
import { STORAGE_KEYS } from './constants';
import App from './App';

// Another tab's writes, made after this tab read the save and before it stores its own.
const otherTab = vi.hoisted(() => ({ afterTake: undefined as undefined | (() => void) }));
vi.mock('./game/pulls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./game/pulls')>();
  return {
    ...actual,
    takePendingPacks: () => {
      const packs = actual.takePendingPacks();
      otherTab.afterTake?.();
      return packs;
    },
  };
});
// The pack opener, down to the pack it hands the app when a reveal ends.
const opener = vi.hoisted(() => ({ onOpen: undefined as undefined | ((pack: OpenedPack) => void) }));
vi.mock('./components/pack/PackOpener', () => ({
  default: (props: { onOpen: (pack: OpenedPack) => void }) => {
    opener.onOpen = props.onOpen;
    return null;
  },
}));

const STALE = 'This save changed in another tab';
const set = SETS.find((s) => s.id === DEFAULT_SET_ID)!;

const owedPack = (nonce: number, cardId = set.cards[0].id): OpenedPack => {
  const cards = toCardsWithMeta([{ setId: set.id, cardId, isHolo: false }]);
  return { setId: set.id, setVersion: set.version, nonce, publicKeyHex: getPlayer().publicKeyHex, cards, score: scoreCards(cards), openedAt: 1 };
};
const shelfNonces = (): number[] => (JSON.parse(localStorage.getItem(STORAGE_KEYS.PENDING_PACKS) ?? '[]') as { n: number }[]).map((p) => p.n);
const normalCount = (cardId: string): number =>
  (JSON.parse(localStorage.getItem(STORAGE_KEYS.COLLECTION) ?? '{}') as Record<string, { normalCount: number }>)[`${set.id}/${cardId}`]?.normalCount ?? 0;
const packsOpened = (): number => (JSON.parse(localStorage.getItem(STORAGE_KEYS.STATS) ?? '{}') as { packsOpened: number }).packsOpened;

// A card's entry as a tab stores it in the collection, with one normal copy.
const stored = (cardId: string): [string, unknown] => {
  const [card] = toCardsWithMeta([{ setId: set.id, cardId, isHolo: false }]);
  return [card.key, { card: { key: card.key, setId: card.setId, id: card.id, name: card.name, rarity: card.rarity, image: card.image }, normalCount: 1, holoCount: 0 }];
};

// What the other tab stores after it records a pack: more packs counted, and a card this tab never saw.
const otherCard = set.cards[1].id;
const otherStats = JSON.stringify({ packsOpened: 5, holoCards: {}, highestPackValue: 0, highestPackCards: [] });
const otherCollection = JSON.stringify(Object.fromEntries([stored(otherCard)]));
const recordInOtherTab = () => {
  localStorage.setItem(STORAGE_KEYS.STATS, otherStats);
  localStorage.setItem(STORAGE_KEYS.COLLECTION, otherCollection);
};
// Another tab loads: it takes this player's packs off the shelf and stores them (only uncounted ones count).
const loadInOtherTab = (cardIds: string[], opened: number) => {
  localStorage.removeItem(STORAGE_KEYS.PENDING_PACKS);
  localStorage.setItem(STORAGE_KEYS.COLLECTION, JSON.stringify(Object.fromEntries(cardIds.map(stored))));
  localStorage.setItem(STORAGE_KEYS.STATS, JSON.stringify({ packsOpened: opened, holoCards: {}, highestPackValue: 0, highestPackCards: [] }));
  window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEYS.STATS }));
};

let container: HTMLDivElement;
let root: Root;
const mount = async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
};
const reload = async () => {
  await act(async () => root.unmount());
  container.remove();
  await mount();
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no matchMedia or ResizeObserver; the pack opener only uses them for motion and layout.
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // jsdom has no media playback (the background music).
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  localStorage.clear();
  otherTab.afterTake = undefined;
  opener.onOpen = undefined;
  localStorage.setItem(STORAGE_KEYS.STATS, JSON.stringify({ packsOpened: 1, holoCards: {}, highestPackValue: 0, highestPackCards: [] }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a tab whose save another tab of the same player has written since', () => {
  it('does not store its older progress over the other tab’s pack, and puts its owed pack back on the shelf', async () => {
    savePendingPack(owedPack(7));
    otherTab.afterTake = recordInOtherTab;
    await mount();
    expect(localStorage.getItem(STORAGE_KEYS.STATS)).toBe(otherStats);
    expect(localStorage.getItem(STORAGE_KEYS.COLLECTION)).toBe(otherCollection);
    // Taken off the shelf at load and never stored here: the next load adds it.
    expect(shelfNonces()).toContain(7);
    expect(container.textContent).toContain(STALE);
  });

  it('hears another tab record a pack and stops opening packs before it next writes', async () => {
    await mount();
    expect(container.textContent).not.toContain(STALE);
    await act(async () => {
      recordInOtherTab();
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEYS.STATS }));
    });
    expect(container.textContent).toContain(STALE);
  });

  it('is not taken for another tab’s write when its own write runs out of space, and still hears a later one', async () => {
    const realSetItem = Storage.prototype.setItem;
    const quota = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === STORAGE_KEYS.STATS) throw new DOMException('full', 'QuotaExceededError');
      realSetItem.call(this, key, value);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = localStorage.getItem(STORAGE_KEYS.STATS);
    savePendingPack(owedPack(7));
    await mount();
    // The owed pack's collection was stored; its stats ran out of space and stayed as they were.
    expect(localStorage.getItem(STORAGE_KEYS.COLLECTION)).toContain(`${set.id}/${set.cards[0].id}`);
    expect(localStorage.getItem(STORAGE_KEYS.STATS)).toBe(before);
    expect(container.textContent).toContain("Some changes couldn't be saved");
    expect(container.textContent).not.toContain(STALE);
    quota.mockRestore();
    await act(async () => {
      recordInOtherTab();
      window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEYS.COLLECTION }));
    });
    expect(container.textContent).toContain(STALE);
  });

  it('does not put back a pack it opened that another tab took off the shelf and stored during the reveal', async () => {
    await mount();
    const card = set.cards[1].id;
    // Torn open here, so on the shelf (as openPack leaves it) while its reveal plays.
    const torn = owedPack(9, card);
    savePendingPack(torn);
    await act(async () => loadInOtherTab([card], 2));
    expect(container.textContent).toContain(STALE);
    // The reveal ends after that, and the pack is handed to the app.
    await act(async () => opener.onOpen!(torn));
    expect(shelfNonces()).not.toContain(9);
    await reload();
    // Counted once: by the other tab.
    expect(normalCount(card)).toBe(1);
    expect(packsOpened()).toBe(2);
  });

  it('does not put back a pack it shelved as counted when its collection ran out of space, once another tab stored it', async () => {
    const realSetItem = Storage.prototype.setItem;
    const quota = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === STORAGE_KEYS.COLLECTION) throw new DOMException('full', 'QuotaExceededError');
      realSetItem.call(this, key, value);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const owedCard = set.cards[0].id;
    const tornCard = set.cards[1].id;
    savePendingPack(owedPack(7, owedCard));
    await mount();
    // Taken at load, then back on the shelf marked as counted, with the stats that count it.
    expect(shelfNonces()).toEqual([7]);
    expect(packsOpened()).toBe(2);
    quota.mockRestore();
    const torn = owedPack(9, tornCard);
    savePendingPack(torn);
    // The other tab adds both and counts only the unmarked one.
    await act(async () => loadInOtherTab([owedCard, tornCard], 3));
    expect(container.textContent).toContain(STALE);
    await act(async () => opener.onOpen!(torn));
    expect(shelfNonces()).toEqual([]);
    await reload();
    expect(normalCount(owedCard)).toBe(1);
    expect(normalCount(tornCard)).toBe(1);
    expect(packsOpened()).toBe(3);
  });

  it('keeps a pack it took at load owed, with the save warning up, while the shelf refuses it, and puts it back on the next try', async () => {
    savePendingPack(owedPack(7));
    const realSetItem = Storage.prototype.setItem;
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === STORAGE_KEYS.PENDING_PACKS) throw new DOMException('full', 'QuotaExceededError');
      realSetItem.call(this, key, value);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    otherTab.afterTake = recordInOtherTab;
    await mount();
    expect(shelfNonces()).not.toContain(7);
    expect(container.textContent).toContain(STALE);
    expect(container.textContent).toContain("Some changes couldn't be saved");
    refuse.mockRestore();
    // Another tab's next write tries again.
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEYS.STATS })));
    expect(shelfNonces()).toEqual([7]);
    expect(localStorage.getItem(STORAGE_KEYS.STATS)).toBe(otherStats);
    otherTab.afterTake = undefined;
    await reload();
    // Added once, by the load after the other tab's progress.
    expect(normalCount(set.cards[0].id)).toBe(1);
    expect(normalCount(otherCard)).toBe(1);
    expect(packsOpened()).toBe(6);
  });
});
