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

const STALE = 'This save changed in another tab';
const set = SETS.find((s) => s.id === DEFAULT_SET_ID)!;

const owedPack = (nonce: number): OpenedPack => {
  const cards = toCardsWithMeta([{ setId: set.id, cardId: set.cards[0].id, isHolo: false }]);
  return { setId: set.id, setVersion: set.version, nonce, publicKeyHex: getPlayer().publicKeyHex, cards, score: scoreCards(cards), openedAt: 1 };
};
const shelfNonces = (): number[] => (JSON.parse(localStorage.getItem(STORAGE_KEYS.PENDING_PACKS) ?? '[]') as { n: number }[]).map((p) => p.n);

// What the other tab stores after it records a pack: more packs counted, and a card this tab never saw.
const otherCard = set.cards[1].id;
const otherStats = JSON.stringify({ packsOpened: 5, holoCards: {}, highestPackValue: 0, highestPackCards: [] });
const otherCollection = JSON.stringify({ [`${set.id}/${otherCard}`]: { normalCount: 1, holoCount: 0 } });
const recordInOtherTab = () => {
  localStorage.setItem(STORAGE_KEYS.STATS, otherStats);
  localStorage.setItem(STORAGE_KEYS.COLLECTION, otherCollection);
};

let container: HTMLDivElement;
let root: Root;
const mount = async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
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
});
