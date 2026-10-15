import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { SetDefinition } from '../../src/engine/types';
import { STORAGE_KEYS } from '../../src/constants/config';
import { cardPreviewPath, previewPath } from '../../src/game/previewLinks';
import { expectDecoded, monitor, snapshot } from './support';

const json = <T,>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
const vectors = json<typeof import('../../spec/vectors.json')>('../../spec/vectors.json');
const pythonVectors = json<typeof import('../../spec/vectors-python.json')>('../../spec/vectors-python.json');

const proofState = async (page: Page) => ({
  recorded: await snapshot(page),
  provenance: await page.evaluate((keys) => Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])), [
    'brainrot-player-v1', STORAGE_KEYS.ACHIEVEMENTS, STORAGE_KEYS.PENDING_PACK, STORAGE_KEYS.HALL_OF_FAME, STORAGE_KEYS.PULLS,
  ]),
});

// Published vectors pin real signatures, ticket work, card order and scores. Never stub the
// browser verifier/worker or regenerate expected cards from the implementation under test.
const cases = [
  { vector: vectors.valid.find((v) => v.note === 'empty name, archived set')!, entry: 'direct' },
  { vector: vectors.valid.find((v) => v.note === 'modifiers: a misprint')!, entry: 'pack-preview' },
  { vector: pythonVectors.valid.find((v) => v.note === 'modifiers (§5.4): a Silver misprint, stacked')!, entry: 'card-preview' },
] as const;

for (const { vector, entry } of cases) {
  test(`verifies ${vector.note} from ${entry}, inspects exact cards and returns to opening`, async ({ page, baseURL }) => {
    test.setTimeout(60000);
    const errors = await monitor(page, baseURL!);
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    const before = await proofState(page);
    const [setId, version] = vector.set.split('@');
    const latest = json<SetDefinition>(`../../src/content/sets/${setId}/set.json`);
    const set = latest.version === Number(version) ? latest : json<SetDefinition>(`../../src/content/sets/${setId}/set.v${version}.json`);
    expect(set.version).toBe(Number(version));
    const path = entry === 'card-preview'
      ? cardPreviewPath(setId, vector.cards[2].cardId)
      : entry === 'pack-preview'
        ? previewPath({ setId, cardIds: ['remember-november'], hand: 'PAIR' })
        : '';
    const response = await page.goto(`./${path}#/pull/${vector.proof}`);
    // Direct fragment navigation returns null; preview pages must be real HTTP responses.
    if (path) expect(response?.status()).toBe(200);
    // Static preview pages forward the fragment intact to the real application.
    await expect(page).toHaveURL(`${baseURL}#/pull/${vector.proof}`);
    const pull = page.getByRole('dialog', { name: vector.hand === 'No Matches' ? 'A pull' : vector.hand, exact: true });
    await expect(pull).toBeVisible({ timeout: 20000 });
    await expect(pull).toContainText('Verified on this device');
    await expect(pull.locator('.sheet-subtitle')).toContainText(`${set.name} · ${vector.name || 'Anonymous'}`);
    await expect(pull.locator('.share-fp')).toHaveText(`#${vector.fingerprint}`);
    await expect(pull.locator('.pull-viewer-cert')).toContainText(`Cert ${vector.fingerprint} ·`);
    await expect(pull.locator('.pull-viewer-cert')).toContainText(`#${vector.nonce}`);
    await expect(pull.locator('.score-panel-total')).toHaveText(vector.score.toLocaleString('en-US'));
    await expect(pull.locator('.score-panel-math')).toContainText(vector.hand);
    await expect(pull.locator('.score-panel-math')).toContainText(`${vector.points.toLocaleString('en-US')} pts ×`);
    await expect(pull.locator('.score-panel-math strong')).toHaveText(vector.multiplier.toLocaleString('en-US'));
    const cards = pull.locator('.pack-viewer-cards > button');
    await expect(cards).toHaveCount(vector.cards.length);
    for (const [index, expected] of vector.cards.entries()) {
      const card = cards.nth(index);
      const definition = set.cards.find((c) => c.id === expected.cardId)!;
      const finish = 'finish' in expected && typeof expected.finish === 'string' ? expected.finish : null;
      const misprint = 'misprint' in expected && expected.misprint;
      const modifiers = [finish && `${finish[0]}${finish.slice(1).toLowerCase()}`, expected.isHolo && 'Holo', misprint && 'Misprint'].filter(Boolean);
      await expect(card).toHaveAccessibleName(`${definition.name}${modifiers.length ? ` (${modifiers.join(' · ')})` : ''}`);
      await expect(card).toHaveClass(new RegExp(`\\b${expected.rarity.toLowerCase()}\\b`));
      const classes = (await card.getAttribute('class'))!.split(/\s+/);
      expect(classes.includes('holo')).toBe(expected.isHolo);
      expect(classes.includes('misprint')).toBe(!!misprint);
      expect(classes.filter((c) => c.startsWith('finish-'))).toEqual(finish ? [`finish-${finish.toLowerCase()}`] : []);
      await expectDecoded(card.locator('img'), 1);
      await expect(card.locator('img')).toBeVisible();
      if (!finish) {
        await expect(card.locator('img')).toHaveAttribute('src', new RegExp(`/assets/${expected.cardId}-[\\w-]+\\.webp$`));
      }
      // Finish rendering keeps the image hidden until its modified frame is ready.
      await card.click();
      const detail = page.getByRole('dialog', { name: definition.name, exact: true });
      await expect(detail).toBeVisible();
      await expectDecoded(detail.locator('.card-viewer-card img'), misprint ? 2 : 1);
      await expect(detail.locator('.card-viewer-card img').first()).toBeVisible();
      for (const label of modifiers) await expect(detail.locator('.rarity-pill')).toContainText(label as string);
      // Viewing another player's signed proof never grants permission to sign their cards.
      await expect(detail.getByRole('button', { name: 'Share card', exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(detail).toHaveCount(0);
      await expect(pull).toBeVisible();
      await expect(card).toBeFocused();
    }
    await pull.getByText('How do we know?', { exact: true }).click();
    await expect(pull.locator('details')).toContainText(`${set.name} v${version}`);
    expect(await proofState(page)).toEqual(before);
    await pull.getByRole('button', { name: 'Open your own packs', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(baseURL!);
    await expect(page.getByRole('button', { name: /^Open a .* pack$/ })).toBeEnabled();
    await page.reload();
    await expect(page.locator('.app-logo')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await proofState(page)).toEqual(before);
    expect(errors).toEqual([]);
  });
}

const invalidCases = [
  { proof: 'cut-off', title: "This link doesn't work", reason: 'It looks cut off or changed' },
  { proof: vectors.invalid.find((v) => v.note === 'truncated')!.proof, title: 'Not a valid pull', reason: 'Proof is truncated' },
  { proof: vectors.invalid.find((v) => v.note === 'signature byte flipped')!.proof, title: 'Not a valid pull', reason: 'Signature does not match' },
];

for (const invalid of invalidCases) {
  test(`rejects shared pull: ${invalid.reason}`, async ({ page, baseURL }) => {
    const errors = await monitor(page, baseURL!);
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    const before = await proofState(page);
    // Hash navigation also tests replacing a route in an already mounted app.
    await page.evaluate((proof) => { window.location.hash = `#/pull/${proof}`; }, invalid.proof);
    const dialog = page.getByRole('dialog', { name: invalid.title, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(invalid.reason);
    await expect(page.locator('.pull-viewer-cert, .pack-viewer-cards')).toHaveCount(0);
    expect(await proofState(page)).toEqual(before);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page).toHaveURL(baseURL!);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Open a .* pack$/ })).toBeEnabled();
    await page.reload();
    await expect(page.locator('.app-logo')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await proofState(page)).toEqual(before);
    expect(errors).toEqual([]);
  });
}
