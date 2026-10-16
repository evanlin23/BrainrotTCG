// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

const SEED = {
  'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Mounted fixture', nextNonce: 0, createdAt: 1 }),
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ musicVolume: 0, effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
  [STORAGE_KEYS.SELECTED_SET]: 'right-now',
};

const currentTab = () => document.querySelector('.app-nav [aria-current="page"]')?.textContent ?? null;
const button = (label: string) => {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].reverse()
    .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label);
  expect(element, `button ${label}`).toBeDefined();
  return element!;
};
const toggle = (label: string) => {
  const element = [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
    .find((el) => document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent === label);
  expect(element, `switch ${label}`).toBeDefined();
  return element!;
};
const settings = () => JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS)!) as { particlesEnabled?: boolean };
const hofStatus = () => document.querySelector('.hall-of-fame [role="status"]');

async function openPack(current: NonNullable<typeof app>) {
  await current.until('the pack shell is ready', () => expect(document.querySelector('.pack-open-button')).not.toBeNull());
  await current.interact(() => {
    // The Open pack button under the pack: the same opening as a finished swipe (#312).
    const open = document.querySelector<HTMLButtonElement>('.pack-open-button')!;
    expect(open).not.toBeNull();
    open.focus();
    open.click();
  });
  await current.until('the ticket produces a reveal with Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  await current.interact(() => button('Skip opening animation').click());
  await current.until('Skip completes the summary', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
}

it('reaches best pulls, the name editor, settings and rankings as pages, and each one works', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  await openPack(app);

  // Name edit, on Profile.
  await app.interact(() => button('Profile').click());
  expect(location.hash).toBe('#/profile');
  await app.until('the name editor loads', () => { button('Edit name'); });
  await app.interact(() => button('Edit name').click());
  await app.interact(() => {
    const input = document.querySelector<HTMLInputElement>('input[autocomplete="nickname"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Renamed fixture');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }));
  });
  await app.interact(() => button('Save').click());
  expect(JSON.parse(localStorage.getItem('brainrot-player-v1')!).name).toBe('Renamed fixture');

  // Best pulls, on the same page: the new name, and the pack just opened, which can be opened again.
  await app.until('Best pulls lists the opened pack', () => expect(document.querySelector('#pulls-history-title')?.textContent).toBe('All packs · 1'));
  expect(currentTab()).toBe('Profile');
  expect(document.querySelector('.pulls-page #player h2')?.textContent).toBe('Renamed fixture');
  const row = document.querySelector<HTMLButtonElement>('.pulls-page .pull-row')!;
  expect(row.querySelector('.pull-row-setname')?.textContent).toContain('Summer of Slop');
  expect(row.disabled).toBe(false);
  expect(row.querySelectorAll('.pull-row-thumbs img')).toHaveLength(5);
  expect(document.body.textContent).not.toContain('No packs yet');
  expect(document.querySelector('[role="dialog"]')).toBeNull();

  // Settings, from the gear: a switch saves at once and survives a reload, which lands back on Settings.
  await app.interact(() => button('Settings').click());
  expect(location.hash).toBe('#/settings');
  await app.until('settings load', () => expect(toggle('Particles').getAttribute('aria-checked')).toBe('false'));
  await app.interact(() => toggle('Particles').click());
  expect(toggle('Particles').getAttribute('aria-checked')).toBe('true');
  await app.until('the setting is saved', () => expect(settings().particlesEnabled).toBe(true));
  await app.reload();
  await app.until('settings reload', () => expect(toggle('Particles').getAttribute('aria-checked')).toBe('true'));
  await app.interact(() => button('Close Settings').click());
  await app.until('Open shows again', () => expect(document.querySelector<HTMLElement>('main.app-main')!.hidden).toBe(false));

  // Rankings, the global scope: a failed load offers Retry, and a retry shows the published list.
  const blocked = globalThis.fetch;
  let published: Response = new Response('', { status: 503 });
  const requested: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith('hall-of-fame.json')) return blocked(input, init);
    requested.push(url);
    return Promise.resolve(published);
  }));
  await app.interact(() => { button('Rankings').focus(); button('Rankings').click(); });
  await app.until('the failed load is reported', () => expect(hofStatus()?.textContent).toBe("Couldn't load the rankings. Try again."));
  expect(currentTab()).toBe('Rankings');
  expect(document.activeElement).toBe(hofStatus());
  published = new Response('[]', { headers: { 'content-type': 'application/json' } });
  await app.interact(() => button('Retry loading rankings').click());
  await app.until('the retry loads the list', () => expect(hofStatus()?.textContent).toBe('Rankings loaded.'));
  expect(requested).toHaveLength(2);
  expect(document.querySelector('.hall-of-fame .hof-empty')?.textContent).toContain('Nothing filed here yet.');
  expect(document.querySelector('[aria-label="Retry loading rankings"]')).toBeNull();
  // The legends are part of the app, so the archive shows them whatever the network does.
  await app.interact(() => button('Archive').click());
  expect(document.querySelectorAll('.hall-of-fame .hof-legend').length).toBeGreaterThan(0);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await app.interact(() => button('Close Rankings').click());
  await app.until('Open shows again', () => expect(currentTab()).toBe('Open'));
  expect(location.hash).toBe('');
  // Checking unfiled submissions reaches for the relays, which the harness blocks.
  app.takeErrors(/^Unexpected external I\/O: WebSocket$/);
}, 60_000);
