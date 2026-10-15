import { test, expect, type Page, type Request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { verifyProof } from '../../src/engine/proof';
import type { PulledCard, SetDefinition } from '../../src/engine/types';
import { STORAGE_KEYS } from '../../src/constants/config';
import { cardPreviewPath, previewPath } from '../../src/game/previewLinks';
import { expectDecoded, monitor, snapshot } from './support';

const json = <T,>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
const vectors = json<typeof import('../../spec/vectors.json')>('../../spec/vectors.json');
const pythonVectors = json<typeof import('../../spec/vectors-python.json')>('../../spec/vectors-python.json');

// Sets come from disk: src/content/sets uses Vite glob imports that the Node runner cannot load.
const setFor = (key: string) => {
  const [setId, version] = key.split('@');
  const latest = json<SetDefinition>(`../../src/content/sets/${setId}/set.json`);
  return latest.version === Number(version) ? latest : json<SetDefinition>(`../../src/content/sets/${setId}/set.v${version}.json`);
};
const lookup = (setId: string, version: number) => {
  try {
    return setFor(`${setId}@${version}`);
  } catch {
    return undefined;
  }
};
/** A card as the vectors list it (spec.test.ts): sets with modifiers add finish and misprint. */
const asVector = ({ cardId, rarity, isHolo, finish, misprint }: PulledCard) =>
  finish === undefined ? { cardId, rarity, isHolo } : { cardId, rarity, isHolo, finish, misprint };

// Load failures that are not missing assets. Chromium fetches the favicon after load, so leaving or
// reloading soon after can abort that request. Routing disables Chromium's HTTP cache, so a card shown
// with a finish requests its plain art again each time it mounts, and that request is cancelled once
// the cached finished frame replaces it. Only those exact aborts are forgiven: any other aborted
// request, and every status >= 400 (a missing favicon or card art included), fails the journey.
const ABORTED = 'net::ERR_ABORTED ';
const loadFailures = (errors: string[], baseURL: string, finishedCardIds: readonly string[] = []) => {
  const logo = new URL('logo.png', baseURL).href;
  const assets = new URL('assets/', baseURL).href;
  const forgiven = (url: string) => url === logo || (url.startsWith(assets)
    && finishedCardIds.some((cardId) => new RegExp(`^${cardId}-[\\w-]{8}\\.webp$`).test(url.slice(assets.length))));
  return errors.filter((error) => !(error.startsWith(ABORTED) && forgiven(error.slice(ABORTED.length))));
};

// Opening a shared pull verifies its Argon2id ticket in a worker, which is slow on a cold mobile run.
// Rejections use the same budget so the two paths are held to one standard.
const VIEWER_TIMEOUT = 20000;

// Built-browser journeys verify Argon2id tickets and walk every card, so each gets the same budget.
const JOURNEY_TIMEOUT = 60000;

/**
 * Shared journey setup: records load failures and returns `openRoute`, which enters the app at `route`
 * as a cold load (or reloads it when no route is given) and waits until it is ready. Every entry leaves
 * the current document first, so the app reads the route's fragment when it mounts rather than as a
 * same-document hash change (which page.goto reports as null). Leaving cancels whatever is still
 * loading, so before every exit fonts, background work and requests settle; fonts settle after every
 * arrival too.
 */
async function startJourney(page: Page, baseURL: string) {
  const errors = await monitor(page, baseURL);
  // On every mount the app mines the next pack's ticket in a worker, then preloads that pack's art with
  // new Image(). The page counts both (observing only: messages and images pass through unchanged), so
  // a journey can wait until that work is idle instead of racing it.
  await page.addInitScript(() => {
    let jobs = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private outstanding = 0;
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener('message', () => this.settle(1));
        this.addEventListener('error', () => this.settle(this.outstanding));
      }
      private settle(count: number) {
        const settled = Math.min(count, this.outstanding);
        this.outstanding -= settled;
        jobs -= settled;
      }
      override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
        this.outstanding++;
        jobs++;
        if (options === undefined) super.postMessage(message);
        else super.postMessage(message, options as StructuredSerializeOptions);
      }
      override terminate() {
        this.settle(this.outstanding);
        super.terminate();
      }
    };
    const images = new Set<WeakRef<HTMLImageElement>>();
    const NativeImage = window.Image;
    window.Image = Object.assign(function TrackedImage(width?: number, height?: number) {
      const image = new NativeImage(width, height);
      images.add(new WeakRef(image));
      return image;
    }, { prototype: NativeImage.prototype }) as unknown as typeof Image;
    Object.defineProperty(window, '__journeyIdle', {
      value: () => jobs === 0 && [...images].every((image) => image.deref()?.complete ?? true),
    });
  });
  const origin = `${new URL(baseURL).origin}/`;
  const inFlight = new Set<Request>();
  page.on('request', (request) => { if (request.url().startsWith(origin)) inFlight.add(request); });
  page.on('requestfinished', (request) => inFlight.delete(request));
  page.on('requestfailed', (request) => inFlight.delete(request));
  const fontsSettled = () => page.evaluate(async () => { await document.fonts.ready; });
  async function openRoute(route?: string) {
    if (page.url() !== 'about:blank') {
      await fontsSettled();
      await page.waitForFunction(() => (window as unknown as { __journeyIdle: () => boolean }).__journeyIdle(), undefined, { timeout: VIEWER_TIMEOUT });
      await expect.poll(() => [...inFlight].map((request) => request.url())).toEqual([]);
      if (route !== undefined) await page.goto('about:blank');
    }
    const response = route === undefined ? await page.reload() : await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(page.locator('.app-logo')).toBeVisible();
    await fontsSettled();
  }
  return { errors, openRoute };
}

const proofState = async (page: Page) => ({
  recorded: await snapshot(page),
  provenance: await page.evaluate((keys) => Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])), [
    'brainrot-player-v1', STORAGE_KEYS.ACHIEVEMENTS, STORAGE_KEYS.PENDING_PACKS, STORAGE_KEYS.PENDING_PACK,
    STORAGE_KEYS.HALL_OF_FAME, STORAGE_KEYS.PULLS,
  ]),
});

/**
 * Back on the opener, reaches every destination through the real navigation: the main nav (Open
 * packs, My cards, Rankings), the personal nav inside My cards (Cards, Best pulls), and the header
 * utilities (Player, with Goals & rewards and Save & restore, and the Sound & display gear). Each one
 * must render and give the opener back when it closes. Nothing here saves, imports, exports or submits.
 */
async function walkDestinations(page: Page) {
  const main = page.getByRole('navigation', { name: 'Main', exact: true });
  const navItem = (name: string) => main.getByRole('button', { name, exact: true });
  const opener = page.getByRole('button', { name: /^Open a .* pack$/ });
  const dialog = (name: string) => page.getByRole('dialog', { name, exact: true });
  const backToOpening = async () => {
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(navItem('Open packs')).toHaveAttribute('aria-current', 'page');
    await expect(opener).toBeEnabled();
  };
  const close = async (sheet: ReturnType<typeof dialog>) => {
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await backToOpening();
  };

  await navItem('My cards').click();
  const myCards = dialog('My cards');
  const personal = myCards.getByRole('navigation', { name: 'My cards', exact: true });
  await expect(myCards).toHaveClass(/\bcollection\b/);
  // Viewing someone else's pull records nothing, so this player's collection is still empty.
  await expect(myCards.locator('.collection-empty')).toHaveText('Open packs to start your collection.');
  await expect(navItem('My cards')).toHaveAttribute('aria-current', 'page');
  await expect(personal.getByRole('button', { name: 'Cards', exact: true })).toHaveAttribute('aria-current', 'page');
  await personal.getByRole('button', { name: 'Best pulls', exact: true }).click();
  await expect(myCards).toHaveClass(/\bpulls-page\b/);
  await expect(myCards.locator('.sheet-subtitle')).toContainText('Browser smoke fixture');
  await expect(personal.getByRole('button', { name: 'Best pulls', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(personal.getByRole('button', { name: 'Cards', exact: true })).not.toHaveAttribute('aria-current');
  await expect(navItem('My cards')).toHaveAttribute('aria-current', 'page');
  // Back from Best pulls to Cards stays inside My cards.
  await personal.getByRole('button', { name: 'Cards', exact: true }).click();
  await expect(myCards).toHaveClass(/\bcollection\b/);
  await expect(personal.getByRole('button', { name: 'Cards', exact: true })).toHaveAttribute('aria-current', 'page');
  await close(myCards);
  // Switching between Cards and Best pulls swaps sheets; focus still returns to what opened My cards.
  await expect(navItem('My cards')).toBeFocused();

  await navItem('Rankings').click();
  const rankings = dialog('Rankings');
  await expect(rankings).toBeVisible();
  await expect(rankings).toHaveClass(/\bhall-of-fame\b/);
  await expect(navItem('Rankings')).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await backToOpening();
  await expect(navItem('Rankings')).toBeFocused();

  const playerButton = page.getByRole('button', { name: 'Player', exact: true });
  await playerButton.click();
  let player = dialog('Player');
  await expect(player.getByRole('textbox', { name: 'Name shown on shared pulls', exact: true })).toHaveValue('Browser smoke fixture');
  await expect(player.getByText(/^Player ID #/)).toBeVisible();
  await player.getByRole('button', { name: 'Goals & rewards', exact: true }).click();
  const goals = dialog('Goals & rewards');
  await expect(goals).toBeVisible();
  await expect(player).toHaveCount(0);
  await close(goals);
  await expect(playerButton).toBeFocused();

  await playerButton.click();
  player = dialog('Player');
  await player.getByRole('button', { name: 'Save & restore', exact: true }).click();
  const save = dialog('Save & restore');
  await expect(save.getByRole('heading', { name: 'Save data', exact: true })).toBeVisible();
  await expect(save.getByRole('heading', { name: 'Experience', exact: true })).toHaveCount(0);
  await expect(player).toHaveCount(0);
  await close(save);
  await expect(playerButton).toBeFocused();

  const gear = page.getByRole('button', { name: 'Sound & display', exact: true });
  await gear.click();
  const sound = dialog('Sound & display');
  await expect(sound.getByRole('heading', { name: 'Experience', exact: true })).toBeVisible();
  await expect(sound.getByRole('slider').first()).toBeVisible();
  await expect(sound.getByRole('heading', { name: 'Save data', exact: true })).toHaveCount(0);
  await close(sound);
  await expect(gear).toBeFocused();

  await navItem('Open packs').click();
  await backToOpening();
}

// Published vectors pin real signatures, ticket work, card order and scores. Never stub the
// browser verifier/worker or regenerate expected cards from the implementation under test.
const cases = [
  { vector: vectors.valid.find((v) => v.note === 'empty name, archived set')!, entry: 'direct' },
  { vector: vectors.valid.find((v) => v.note === 'modifiers: a misprint')!, entry: 'pack-preview' },
  { vector: pythonVectors.valid.find((v) => v.note === 'modifiers (§5.4): a Silver misprint, stacked')!, entry: 'card-preview' },
] as const;

for (const { vector, entry } of cases) {
  test(`verifies ${vector.note} from ${entry}, inspects exact cards, returns to opening and reaches every destination`, async ({ page, baseURL }) => {
    test.setTimeout(JOURNEY_TIMEOUT);
    const { errors, openRoute } = await startJourney(page, baseURL!);
    await openRoute('./');
    const before = await proofState(page);
    const [setId, version] = vector.set.split('@');
    const set = setFor(vector.set);
    expect(set.version).toBe(Number(version));
    // The engine re-derives the pinned vector in Node, so the UI below is held to both.
    const derived = await verifyProof(vector.proof, lookup);
    expect({
      name: derived.proof.name, nonce: derived.proof.nonce, fingerprint: derived.fingerprint, cards: derived.cards.map(asVector),
      points: derived.score.points, hand: derived.score.hand.name, multiplier: derived.score.hand.multiplier, score: derived.score.score,
    }).toEqual({
      name: vector.name, nonce: vector.nonce, fingerprint: vector.fingerprint, cards: vector.cards,
      points: vector.points, hand: vector.hand, multiplier: vector.multiplier, score: vector.score,
    });
    const path = entry === 'card-preview'
      ? cardPreviewPath(setId, vector.cards[2].cardId)
      : entry === 'pack-preview'
        ? previewPath({ setId, cardIds: ['remember-november'], hand: 'PAIR' })
        : '';
    await openRoute(`./${path}#/pull/${vector.proof}`);
    // Static preview pages forward the fragment intact to the real application.
    await expect(page).toHaveURL(`${baseURL}#/pull/${vector.proof}`);
    const pull = page.getByRole('dialog', { name: vector.hand === 'No Matches' ? 'A pull' : vector.hand, exact: true });
    await expect(pull).toBeVisible({ timeout: VIEWER_TIMEOUT });
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
    await walkDestinations(page);
    await expect(page).toHaveURL(baseURL!);
    expect(await proofState(page)).toEqual(before);
    await openRoute();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await proofState(page)).toEqual(before);
    const finishedCardIds = vector.cards.flatMap((card) => 'finish' in card && card.finish ? [card.cardId] : []);
    expect(loadFailures(errors, baseURL!, finishedCardIds)).toEqual([]);
  });
}

const invalidVector = (note: string) => vectors.invalid.find((v) => v.note === note)!;
const cutOff = { proof: 'cut-off', title: "This link doesn't work", reason: 'It looks cut off or changed' };
const invalidCases = [
  { ...cutOff, entry: 'hash change' },
  // The same broken link opened cold is caught by the app's mount-time read of the fragment.
  { ...cutOff, entry: 'cold load' },
  { ...invalidVector('truncated'), title: 'Not a valid pull', reason: 'Proof is truncated', entry: 'hash change' },
  { ...invalidVector('signature byte flipped'), title: 'Not a valid pull', reason: 'Signature does not match', entry: 'hash change' },
  // Tampered after signing: the claimed pack changes, so the original signature no longer covers it.
  { ...invalidVector('nonce changed after signing'), title: 'Not a valid pull', reason: 'Signature does not match', entry: 'hash change' },
  { ...invalidVector('small-order public key with a forged signature'), title: 'Not a valid pull', reason: 'Not a valid player key', entry: 'hash change' },
];

for (const invalid of invalidCases) {
  test(`rejects shared pull: ${'note' in invalid ? invalid.note : invalid.proof} (${invalid.entry})`, async ({ page, baseURL }) => {
    test.setTimeout(JOURNEY_TIMEOUT);
    if ('rule' in invalid) {
      // The engine rejects it for the vector's rule; the app must show that, not render a pull.
      await expect(verifyProof(invalid.proof, lookup)).rejects.toMatchObject({ rule: invalid.rule });
    }
    const { errors, openRoute } = await startJourney(page, baseURL!);
    await openRoute('./');
    const before = await proofState(page);
    if (invalid.entry === 'cold load') {
      await openRoute(`./#/pull/${invalid.proof}`);
    } else {
      // Hash navigation also tests replacing a route in an already mounted app.
      await page.evaluate((proof) => { window.location.hash = `#/pull/${proof}`; }, invalid.proof);
    }
    const dialog = page.getByRole('dialog', { name: invalid.title, exact: true });
    await expect(dialog).toBeVisible({ timeout: VIEWER_TIMEOUT });
    await expect(dialog).toContainText(invalid.reason);
    await expect(page.locator('.pull-viewer-cert, .pack-viewer-cards')).toHaveCount(0);
    expect(await proofState(page)).toEqual(before);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page).toHaveURL(baseURL!);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Open a .* pack$/ })).toBeEnabled();
    await openRoute();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await proofState(page)).toEqual(before);
    expect(loadFailures(errors, baseURL!)).toEqual([]);
  });
}
