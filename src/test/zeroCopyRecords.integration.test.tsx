// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants/config';
import { COLLECTIBLE_CARDS, getSetCards } from '../data/cards';
import { exportSaveFile, importSaveFile } from '../game/saveFile';
import { CURRENT_DATA_VERSION, hydrateCollection } from '../utils/migrations';
import { getStoredData } from '../utils/storage';
import { isCardOwned } from '../game/versions';
import { checkCollectionAchievements } from '../utils/achievementChecks';
import { setCompleteId } from '../data/achievements';
import CollectionBrowser from '../components/collection/CollectionBrowser';
import type { CollectionItem } from '../types';

let root: Root | undefined;
let container: HTMLElement | undefined;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = undefined;
  }
  container?.remove();
  container = undefined;
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('zero-copy records lifecycle (#812)', () => {
  it('covers importer -> hydration -> render/achievement behavior with zero-copy fixture and positive control', () => {
    const rightNowCards = getSetCards('right-now');
    expect(rightNowCards.length).toBe(12);

    // 1 positive control card, 11 zero-copy cards
    const positiveCard = rightNowCards[0];
    const zeroCards = rightNowCards.slice(1);

    const rawCollection: Record<string, unknown> = {
      [positiveCard.key]: {
        card: { id: positiveCard.id, key: positiveCard.key, setId: 'right-now', name: positiveCard.name, image: positiveCard.image, rarity: positiveCard.rarity },
        normalCount: 2,
        holoCount: 1,
      },
    };

    for (const card of zeroCards) {
      rawCollection[card.key] = {
        card: { id: card.id, key: card.key, setId: 'right-now', name: card.name, image: card.image, rarity: card.rarity },
        normalCount: 0,
        holoCount: 0,
      };
    }

    const savePayload = {
      version: 2,
      dataVersion: CURRENT_DATA_VERSION,
      exportedAt: new Date().toISOString(),
      collection: JSON.stringify(rawCollection),
      stats: JSON.stringify({ packsOpened: 5 }),
      settings: JSON.stringify({}),
    };

    // 1. Importer accepts the save file
    const importError = importSaveFile(JSON.stringify(savePayload));
    expect(importError).toBeNull();

    // Export preserves the records without destructive deletion
    const exported = JSON.parse(exportSaveFile());
    const exportedCollection = JSON.parse(exported.collection);
    expect(exportedCollection[positiveCard.key]).toBeDefined();
    for (const card of zeroCards) {
      expect(exportedCollection[card.key]).toBeDefined();
      expect(exportedCollection[card.key].normalCount).toBe(0);
      expect(exportedCollection[card.key].holoCount).toBe(0);
    }

    // 2. Hydration
    const rawStored = getStoredData<Record<string, CollectionItem>>(STORAGE_KEYS.COLLECTION, {});
    const hydrated = hydrateCollection(rawStored);

    // Ownership predicate check
    expect(isCardOwned(hydrated[positiveCard.key])).toBe(true);
    for (const card of zeroCards) {
      expect(isCardOwned(hydrated[card.key])).toBe(false);
    }

    // 3. Achievement behavior
    const achievements = checkCollectionAchievements(hydrated, { packsOpened: 5, holoCards: {} }, {});
    expect(achievements).not.toContain('collect_5');
    expect(achievements).not.toContain('collect_10');
    expect(achievements).not.toContain('complete_collection');
    expect(achievements).not.toContain(setCompleteId('right-now'));

    // 4. Render CollectionBrowser
    act(() => {
      root!.render(<CollectionBrowser collection={hydrated} recentSetId="right-now" />);
    });

    const page = container!.querySelector('.collection')!;
    expect(page).not.toBeNull();

    // Subtitle must only report the 1 genuinely owned card
    const subtitle = page.querySelector('.page-subtitle')!.textContent!;
    expect(subtitle).toContain(`1/${COLLECTIBLE_CARDS.length} cards`);

    // Set header shows 1/12, no Complete tag
    const header = page.querySelector('.collection-set-header')!;
    expect(header.textContent).toContain('1/12');
    expect(header.querySelector('.set-badge')).toBeNull();

    // Grid shows exactly 1 clickable owned button; all 11 zero-copy cards render as uncollected slots
    const buttons = page.querySelectorAll('button.collection-item');
    expect(buttons.length).toBe(1);
    expect(buttons[0].getAttribute('aria-label')).toContain('3 owned'); // 2 normal + 1 holo

    const slots = page.querySelectorAll('.collection-slot');
    expect(slots.length).toBe(11);
  });
});
