import { expect, type Page, type Locator } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { cardPoints } from '../../src/engine/scoring';
import { decodeCard } from '../../src/game/cardCode';
import type { Finish, Rarity } from '../../src/engine/types';

// On-disk boundary shapes: importing UI Stats pulls TSX/Vite assets into the Node test project.
interface RecordedCard {
  key: string; setId: string; id: string; name: string; rarity: Rarity; image: string;
  isHolo: boolean; finish?: Finish | null; misprint?: boolean;
}
interface CollectionItem {
  card: Pick<RecordedCard, 'key' | 'setId' | 'id' | 'name' | 'rarity' | 'image'>;
  normalCount: number; holoCount: number;
  finishes?: Partial<Record<Finish, number>>; misprints?: number; modifierPoints?: number;
}
interface Stats {
  packsOpened: number; highestPackCards?: RecordedCard[];
  highestPackRef?: { setId: string; setVersion: number; nonce: number; publicKeyHex?: string };
  highestPackHandName?: string; highestPackFlexValue?: number;
}

export async function monitor(page: Page, baseURL: string, historyRecords = 0, { routeHttp = true } = {}) {
  const errors: string[] = [];
  const origin = new URL(baseURL).origin;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('response', (response) => {
    if (new URL(response.url()).origin === origin && response.status() >= 400) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (new URL(request.url()).origin === origin) {
      errors.push(`${request.failure()?.errorText} ${request.url()}`);
    }
  });
  // Context-wide guards also cover popups and other pages. No server connection is established
  // by this handler, including relay WebSocket writes.
  await page.context().routeWebSocket('**/*', (socket) => socket.close());
  // Playwright HTTP routing disables the HTTP cache, so warm performance runs guard HTTP themselves.
  if (routeHttp) await page.context().route('**/*', (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    // Empty responses avoid disguising local load failures with broad console-error filters.
    return route.fulfill({ status: 204 });
  });
  await page.addInitScript(({ historyRecords, keys, origin }) => {
    if (window.location.origin !== origin) return;
    // Fresh smoke seeds identity/audio only; optional performance history below is synthetic.
    if (!localStorage.getItem('brainrot-player-v1')) {
      localStorage.setItem('brainrot-player-v1', JSON.stringify({
        secretKey: '01'.repeat(32), name: 'Browser smoke fixture', nextNonce: historyRecords, createdAt: 1,
      }));
      localStorage.setItem('brainrot-settings-v1', JSON.stringify({ musicVolume: 0, effectsVolume: 0 }));
      if (historyRecords) {
        // Performance shape only: repeated nonce0 cached cards at synthetic nonces. This is
        // intentionally NOT a verified history/profile, and never enters a proof verifier.
        localStorage.setItem(keys.HISTORY, JSON.stringify(Array.from({ length: historyRecords }, (_, n) => ({
          s: 'right-now', v: 2, n, k: '8a88e3dd7409f195', c: 'bukangi,niu-laiG,bukangi,la-peace,verity', h: 'Pair', x: 1020, t: 1,
        }))));
        localStorage.setItem('brainrot-data-version', '3');
      }
    }
  }, { historyRecords, keys: STORAGE_KEYS, origin });
  return errors;
}

export async function expectDecoded(images: Locator, count: number) {
  await expect(images).toHaveCount(count);
  for (const image of await images.all()) {
    await expect.poll(() => image.evaluate((element: HTMLImageElement) =>
      element.complete && element.naturalWidth > 0 && element.naturalHeight > 0,
    )).toBe(true);
    await image.evaluate((element: HTMLImageElement) => element.decode());
  }
}

export async function snapshot(page: Page) {
  return page.evaluate((keys) => ({
    stats: JSON.parse(localStorage.getItem(keys.STATS) ?? 'null'),
    collection: JSON.parse(localStorage.getItem(keys.COLLECTION) ?? 'null'),
    history: JSON.parse(localStorage.getItem(keys.HISTORY) ?? 'null'),
  }), STORAGE_KEYS) as Promise<{
    stats: Stats;
    collection: Record<string, CollectionItem>;
    history: { s: string; v: number; n: number; k: string; c: string; h: string; x: number; t: number }[];
  }>;
}

export async function expectRecordedPack(page: Page, nonce = 0, historyCount = 1) {
  const before = await snapshot(page);
  expect(before.stats.packsOpened).toBe(1);
  expect(before.stats.highestPackCards).toHaveLength(5);
  const cards = before.stats.highestPackCards!;
  const expectedCollection: Record<string, CollectionItem> = {};
  for (const card of cards) {
    const entry = expectedCollection[card.key] ??= {
      card: { key: card.key, setId: card.setId, id: card.id, name: card.name, rarity: card.rarity, image: card.image },
      normalCount: 0, holoCount: 0,
    };
    if (card.isHolo) entry.holoCount++;
    else entry.normalCount++;
    if (card.finish) {
      entry.finishes ??= {};
      entry.finishes[card.finish] = (entry.finishes[card.finish] ?? 0) + 1;
    }
    if (card.misprint) entry.misprints = (entry.misprints ?? 0) + 1;
    const extra = cardPoints(card.rarity, card.isHolo, card.finish, card.misprint) - cardPoints(card.rarity, card.isHolo);
    if (extra) entry.modifierPoints = (entry.modifierPoints ?? 0) + extra;
  }
  expect(before.collection).toEqual(expectedCollection);
  expect(Object.values(before.collection).reduce((total, entry) => total + entry.normalCount + entry.holoCount, 0)).toBe(5);
  expect(before.history).toHaveLength(historyCount);
  const ref = before.stats.highestPackRef!;
  expect(ref).toMatchObject({ nonce });
  expect(ref.publicKeyHex).toBe('8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c');
  const [history] = before.history;
  expect(history).toMatchObject({
    s: ref.setId, v: ref.setVersion, n: ref.nonce, k: ref.publicKeyHex!.slice(0, 16),
    h: before.stats.highestPackHandName, x: before.stats.highestPackFlexValue,
  });
  expect(history.t).toBeGreaterThan(0);
  expect(history.c.split(',').map(decodeCard)).toEqual(cards.map((card) => ({
    id: card.id, holo: card.isHolo,
    ...(card.finish ? { finish: card.finish } : {}), ...(card.misprint ? { misprint: true } : {}),
  })));
  // Reveals sort by rarity; compare the displayed multiset without changing ticket card order.
  const labels = await page.locator('.summary-card').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
  expect(labels.map((label) => cards.find((card) => label?.startsWith(`${card.name},`))?.key).sort())
    .toEqual(cards.map((card) => card.key).sort());

  return before;
}
