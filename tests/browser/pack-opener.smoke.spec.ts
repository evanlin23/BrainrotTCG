import { test, expect, type Page, type Locator } from '@playwright/test';
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

async function monitor(page: Page, baseURL: string) {
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
  // No server connection is established by this handler, including relay WebSocket writes.
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    // Empty responses avoid disguising local load failures with broad console-error filters.
    return route.fulfill({ status: 204 });
  });
  await page.addInitScript(() => {
    // Only a disposable identity and muted audio preferences are seeded; generation is real.
    if (!localStorage.getItem('brainrot-player-v1')) {
      localStorage.setItem('brainrot-player-v1', JSON.stringify({
        secretKey: '01'.repeat(32), name: 'Browser smoke fixture', nextNonce: 0, createdAt: 1,
      }));
      localStorage.setItem('brainrot-settings-v1', JSON.stringify({ musicVolume: 0, effectsVolume: 0 }));
    }
  });
  return errors;
}

async function expectDecoded(images: Locator, count: number) {
  await expect(images).toHaveCount(count);
  for (const image of await images.all()) {
    await expect.poll(() => image.evaluate((element: HTMLImageElement) =>
      element.complete && element.naturalWidth > 0 && element.naturalHeight > 0,
    )).toBe(true);
    await image.evaluate((element: HTMLImageElement) => element.decode());
  }
}

async function snapshot(page: Page) {
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

test('opens one real pack and preserves its exact cards, counts, modifiers and ticket after reload', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const packShell = page.getByRole('button', { name: /^Open a .* pack$/ });
  await expect(packShell).toBeVisible();
  await expectDecoded(packShell.locator('img'), 2);
  // Keyboard activation exercises the accessible opening control in both viewport projects.
  await packShell.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.summary-title')).not.toBeEmpty();
  await expectDecoded(page.locator('.summary-cards img'), 5);

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
  expect(before.history).toHaveLength(1);
  const ref = before.stats.highestPackRef!;
  expect(ref).toMatchObject({ nonce: 0 });
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

  await page.reload();
  await expect(page.locator('.app-logo')).toBeVisible();
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  const profile = page.locator('.sheet');
  await expect(profile).toContainText('All packs · 1');
  await profile.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Collection', exact: true }).click();
  await expect(page.locator('.collection-set').first()).toBeVisible();
  // Compare after UI hydration, not merely immediately after navigation.
  expect(await snapshot(page)).toEqual(before);
  await page.locator('.sheet').getByRole('button', { name: 'Close', exact: true }).click();
  expect(errors).toEqual([]);
});
