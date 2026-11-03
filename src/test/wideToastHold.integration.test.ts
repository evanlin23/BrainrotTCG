// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

const PLAYER = { 'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Hold fixture', nextNonce: 0, createdAt: 1 }) };
const QUIET = { 'brainrot-settings-v1': JSON.stringify({ effectsVolume: 0, particlesEnabled: false }) };
const RETURNING = { 'brainrot-stats-v1': JSON.stringify({ packsOpened: 1, holoCards: {}, highestPackValue: 0, highestPackCards: [] }) };
const LOST_SET = JSON.stringify({ raw: '{"lost-set/ghost":null}', player: null });

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const toastTexts = () => [...document.querySelectorAll('.toast')].map((el) => el.textContent ?? '');
const banner = () => $('p.save-warning[role="alert"]');
const hideNote = () => [...document.querySelectorAll<HTMLButtonElement>('.save-warning button')].find((el) => el.textContent === 'Hide note');

/** matchMedia as a browser answers it for a window this wide: only the wide-layout query matches. */
const windowOf = (wide: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({
  media: query, matches: wide && query === '(min-width: 900px)', onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent: () => true,
}));

/** Opens the pack and leaves it early: it is put away, and its own notice is queued. */
async function putPackAway() {
  const sealed = () => $('[data-pack-open]');
  await app!.interact(() => { sealed()!.focus(); sealed()!.click(); });
  await app!.until('the pack is open', () => expect($('.card-wrapper')).not.toBeNull());
  await app!.interact(() => (document.activeElement ?? document.body)
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })));
}

async function openWithNote(wide: boolean) {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING, [STORAGE_KEYS.COLLECTION_RECOVERY]: LOST_SET });
  windowOf(wide);
  await app.mount();
  await app.until('the save warning shows', () => expect(banner()).not.toBeNull());
  await putPackAway();
}

it('on a wide screen a toast waits behind the save warning, so it covers no control, and comes in once the note is hidden', async () => {
  await openWithNote(true);
  // Long enough for the notice to show, were anything holding it back not there.
  await app!.settle(1500);
  expect(banner()).not.toBeNull();
  expect(toastTexts()).toEqual([]);

  await app!.interact(() => hideNote()!.click());
  await app!.until('the banner is gone', () => expect(banner()).toBeNull());
  await app!.until('the queued toast follows', () => expect(toastTexts().join(' | ')).toContain('Pack kept'), 60_000);
});

it('on a phone the toast shows with the save warning, as it always did', async () => {
  await openWithNote(false);
  await app!.until('the pack notice shows', () => expect(toastTexts().join(' | ')).toContain('Pack kept'), 60_000);
  expect(banner()).not.toBeNull();
});
