// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].reverse()
  .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label)!;

it('shares the exact owned modifier from a history pack, retaining pack sharing and nested close behavior', async () => {
  app = await mountedApp({
    'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Owned share fixture', nextNonce: 0, createdAt: 1 }),
    [STORAGE_KEYS.SETTINGS]: JSON.stringify({ musicVolume: 0, effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
  });
  let drawCard!: ReturnType<typeof vi.fn>;
  await app.mount(async () => {
    const graphics = await import('../game/bragImage');
    vi.spyOn(graphics, 'renderPoster').mockResolvedValue(new Blob(['pack'], { type: 'image/png' }));
    drawCard = vi.spyOn(graphics, 'renderCardPoster').mockResolvedValue(new Blob(['card'], { type: 'image/png' }));
    // Graphics/URL boundary only: this jsdom regression does not claim actual PNG/native sharing.
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL() { return 'blob:mounted-fixture'; }
      static revokeObjectURL() {}
    });
    return import('../App');
  });
  await app.interact(() => {
    const shell = document.querySelector<HTMLElement>('[aria-label^="Open a "]')!;
    shell.focus();
    shell.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));
  });
  await app.until('real pack reveals', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  await app.interact(() => document.querySelector<HTMLButtonElement>('.reveal-skip')!.click());
  await app.until('summary records the full pack', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
  await app.interact(() => button('Open another pack').click());
  await app.until('manual pack screen returns', () => expect(document.querySelector('[aria-label^="Open a "]')).not.toBeNull());
  await app.interact(() => button('My cards').click());
  await app.until('personal destination opens', () => expect(button('Best pulls')).toBeDefined());
  await app.interact(() => button('Best pulls').click());
  await app.until('history has the owned pack', () => expect(document.querySelector('.pull-row')).not.toBeNull());
  await app.interact(() => document.querySelector<HTMLButtonElement>('.pull-row')!.click());
  await app.until('owned pack exposes all cards', () => expect(document.querySelectorAll('.share-pack-cards .pack-viewer-card-grid')).toHaveLength(5));
  const outer = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].slice(-1)[0]!;
  const actions = outer.querySelector('.share-actions-main')!;
  const preview = outer.querySelector('.share-preview')!;
  expect(actions.compareDocumentPosition(preview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(button('Copy link')).toBeDefined();
  await app.interact(() => button('Niu Lai (Gold)').click());
  await app.until('gold card is inspectable', () => expect(document.querySelector('.card-viewer-card')?.className).toContain('finish-gold'));
  await app.interact(() => button('Share card').click());
  await app.until('exact card share is ready', () => expect(drawCard).toHaveBeenCalled());
  expect(drawCard.mock.calls.slice(-1)[0]?.[0]).toMatchObject({ card: { name: 'Niu Lai', isHolo: false, finish: 'GOLD', misprint: false } });
  expect(document.body.textContent).toContain('ticket #0');
  await app.interact(() => button('Close').click());
  expect(document.querySelector('.card-viewer')).not.toBeNull();
  await app.interact(() => button('Close').click());
  expect(document.querySelector('.card-viewer')).toBeNull();
  expect(document.querySelector('.share-pack-cards')).not.toBeNull();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.STATS)!).packsOpened).toBe(1);
}, 30_000);
