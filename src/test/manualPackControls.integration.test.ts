// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import type { Stats } from '../types';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });
const stats = (): Stats | null => JSON.parse(localStorage.getItem(STORAGE_KEYS.STATS) ?? 'null');
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label)!;
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
/** The sealed pack's Open pack button: there only while the pack is sealed (#312). */
const sealed = () => $('.pack-open-button');
const progress = () => $('.reveal-progress')?.getAttribute('aria-valuenow');
// Nonce 22 of this key deals a special-reveal card, which a big-pull pause holds for its full reveal.
const preferences = ({ nextNonce = 0, pauseBigPulls = false } = {}) => ({
  'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Manual fixture', nextNonce, createdAt: 1 }),
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ musicVolume: 0, effectsVolume: 0, particlesEnabled: false, pauseBigPulls }),
});

/** A mouse press from one element to another; the browser then clicks their nearest shared ancestor. */
function press(down: Element, up: Element, clicked: Element) {
  const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  const init = { bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerType: 'mouse' };
  down.dispatchEvent(new Pointer('pointerdown', init));
  up.dispatchEvent(new Pointer('pointerup', init));
  clicked.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

async function reveal() {
  await app!.interact(() => {
    sealed()!.focus();
    sealed()!.click();
  });
  await app!.until('Open pack reveals the spent pack', () => {
    expect(progress()).toBe('1');
    // The top bar's count shows as the pack opens; the card comes in as the torn pack flies off.
    expect($('.card-wrapper')).not.toBeNull();
  });
  // The leaving pack drops its focused button at once, so focus goes on to the card, not the page.
  expect(document.activeElement?.closest('.reveal-card')).not.toBeNull();
}

const pressA = () => app!.interact(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true })));
// From whatever has focus, as a real key press is: a sheet's own Escape handler sees it first.
const escape = () => app!.interact(() => (document.activeElement ?? document.body)
  .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })));
const toasts = () => [...document.querySelectorAll('.toast')].map((el) => el.textContent ?? '').join(' | ');
// The tabs are hidden while a pack is open, but an address typed or followed still opens a page or a link.
const go = (hash: string) => app!.interact(() => { location.hash = hash; });
const pageTitle = () => document.querySelector('main.page h1')?.textContent ?? null;
// Focus mode: the app's chrome (tabs, set picker, and the header on phones) is hidden around a pack.
const focusMode = () => $('.app')!.classList.contains('is-focus');
const mockPoster = async () => {
  const graphics = await import('../game/bragImage');
  vi.spyOn(graphics, 'renderPoster').mockResolvedValue(new Blob(['pack'], { type: 'image/png' }));
  // Graphics/URL boundary only: jsdom can't draw the poster.
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:mounted-fixture'; }
    static revokeObjectURL() {}
  });
  return import('../App');
};
const summary = async () => {
  await app!.interact(() => button('Skip opening animation').click());
  await app!.until('summary has all cards', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
};

it('ignores the old auto-open key on the sealed pack and during a reveal', async () => {
  app = await mountedApp(preferences());
  await app.mount();
  await pressA();
  await app.settle(3000);
  expect(sealed()).not.toBeNull();
  expect($('.reveal-progress')).toBeNull();
  expect(stats()?.packsOpened ?? 0).toBe(0);

  await reveal();
  await pressA();
  await app.settle(3000);
  expect(progress()).toBe('1');
  expect($('.summary-card')).toBeNull();
  expect(stats()?.packsOpened ?? 0).toBe(0);
}, 30_000);

it('leaves a spent reveal only by its Back to packs button, exactly once: empty space and flings stay', async () => {
  app = await mountedApp(preferences());
  await app.mount();
  for (const index of [0, 1]) {
    await reveal();
    await app.interact(() => $('.card-wrapper')!.click());
    const area = $('.card-reveal-area')!;
    // A fling between the card and empty space, and a tap or click on empty space, don't leave.
    await app.interact(() => press($('.card-wrapper')!, area, area));
    await app.interact(() => press(area, $('.card-wrapper')!, area));
    await app.interact(() => area.click());
    await app.interact(() => press($('.active-card-container')!, area, area));
    await app.interact(() => press(area, area, area));
    await app.settle(400);
    const round = `round ${index + 1}`;
    expect(sealed(), `empty space or a fling left the reveal in ${round}`).toBeNull();
    expect(progress(), `empty space or a fling moved the reveal on in ${round}`).toBe('1');
    expect(stats()?.packsOpened ?? 0, `empty space or a fling recorded the pack in ${round}`).toBe(index);

    await app.interact(() => button('Back to packs').click());
    await app.until('sealed pack is available again', () => expect(sealed()).not.toBeNull());
    expect(button('Back to packs'), 'the packs screen kept the pack\'s X').toBeUndefined();
    expect(stats()?.packsOpened).toBe(index + 1);
    expect(stats()?.highestPackCards).toHaveLength(5);
    await app.interact(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('focus'));
    });
    await pressA();
    await app.settle(1000);
    expect($('.reveal-progress')).toBeNull();
    expect(stats()?.packsOpened).toBe(index + 1);
  }
}, 30_000);

it('does not leave or record a reveal from behind a page, and the reveal is still there when it closes', async () => {
  app = await mountedApp(preferences());
  await app.mount();
  await reveal();
  await app.interact(() => $('.card-wrapper')!.click());
  await go('#/cards');
  await app.until('Cards opens over the reveal', () => expect(pageTitle()).toBe('Cards'));
  expect($('main.app-main')!.hidden).toBe(true);
  await app.interact(() => button('Back to packs').click());
  await escape();
  await app.settle(400);
  expect(progress(), 'a press behind the page left the reveal').toBe('1');
  expect(stats()?.packsOpened ?? 0, 'a press behind the page recorded the pack').toBe(0);
  await app.interact(() => button('Close Cards').click());
  await app.until('the page closes onto the reveal', () => expect($('main.app-main')!.hidden).toBe(false));
  expect(progress()).toBe('1');
  expect(location.hash).toBe('');
  await app.interact(() => button('Back to packs').click());
  await app.until('sealed pack is available again', () => expect(sealed()).not.toBeNull());
  expect(stats()?.packsOpened).toBe(1);
}, 30_000);

it('leaves a reveal with Escape as Back to packs does, and says the face-down cards were kept', async () => {
  app = await mountedApp(preferences());
  await app.mount();
  await reveal();
  await app.interact(() => $('.card-wrapper')!.click());
  expect(toasts()).not.toContain('Pack kept');
  await escape();
  await app.until('Escape closes the reveal', () => expect(sealed()).not.toBeNull());
  expect(stats()?.packsOpened).toBe(1);
  expect(stats()?.highestPackCards).toHaveLength(5);
  await app.until('a notice says the pack was kept', () => expect(toasts()).toContain('Pack kept'));
  expect(toasts()).toContain('Its cards are in Cards');
  // Tapping the notice opens the cards it names.
  await app.interact(() => [...document.querySelectorAll<HTMLButtonElement>('.toast')].find((el) => el.textContent?.includes('Pack kept'))!.click());
  await app.until('Cards opens from the notice', () => expect(pageTitle()).toBe('Cards'));
  expect(location.hash).toBe('#/cards');

  // With no reveal open, Escape on the page or back on Open opens or records nothing.
  await escape();
  await app.settle(400);
  await app.interact(() => button('Close Cards').click());
  await app.until('Open shows again', () => expect($('main.app-main')!.hidden).toBe(false));
  await escape();
  await app.settle(1000);
  expect($('.reveal-progress')).toBeNull();
  expect(stats()?.packsOpened).toBe(1);
}, 30_000);

it('does not say a pack was kept when its save failed', async () => {
  app = await mountedApp(preferences());
  await app.mount();
  // The progress writes App makes after a pack lands are refused, as a full browser storage would.
  const refused: string[] = [STORAGE_KEYS.COLLECTION, STORAGE_KEYS.ACHIEVEMENTS, STORAGE_KEYS.STATS, STORAGE_KEYS.HALL_OF_FAME];
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (refused.includes(key)) throw new DOMException('Full', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
  await reveal();
  await app.interact(() => $('.card-wrapper')!.click());
  await escape();
  await app.until('Escape closes the reveal', () => expect(sealed()).not.toBeNull());
  await app.until('the save warning shows', () => expect($('.app > p[role="alert"].save-warning')?.textContent).toMatch(/couldn't be saved/));
  await app.settle(1000);
  expect(toasts(), 'a pack whose save failed was said to be kept').not.toContain('Pack kept');
  expect(app.takeErrors(/^Failed to save to localStorage key /).length).toBeGreaterThan(0);
}, 30_000);

it('lets Escape close a sheet over the reveal without closing the reveal', async () => {
  app = await mountedApp(preferences());
  await app.mount();
  await reveal();
  // A shared link followed during the reveal: its sheet goes on top of the pack.
  await go('#/pull/cut-off');
  await app.until('a sheet opens over the reveal', () => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  await escape();
  await app.until('Escape closes the sheet', () => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await app.settle(400);
  expect(progress(), 'Escape under a sheet also closed the reveal').toBe('1');
  expect(sealed()).toBeNull();
  expect(stats()?.packsOpened ?? 0, 'Escape under a sheet recorded the pack').toBe(0);
  expect(toasts()).not.toContain('Pack kept');
  expect(location.hash).toBe('');
  await escape();
  await app.until('the next Escape closes the reveal', () => expect(sealed()).not.toBeNull());
  expect(stats()?.packsOpened).toBe(1);
}, 30_000);

it('shares from the summary, which leads with the result and puts its actions after the cards', async () => {
  app = await mountedApp(preferences());
  await app.mount(mockPoster);
  await reveal();
  await summary();
  const cards = $('.summary-cards')!;
  expect(cards.compareDocumentPosition($('.summary-actions')!) & Node.DOCUMENT_POSITION_FOLLOWING, 'the actions came before the cards').toBeTruthy();
  expect($('.summary-title')!.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect($('.summary-actions')!.nextElementSibling, 'something followed the actions').toBeNull();
  // Keyboard focus starts at the result, not on a button below it.
  expect(document.activeElement).toBe($('.summary-title'));
  expect(button('Next pack')).toBeDefined();
  expect(stats()?.packsOpened).toBe(1);
  expect(toasts(), 'a pack seen to the end said it was kept').not.toContain('Pack kept');

  await app.interact(() => button('Share').click());
  await app.until('share sheet opens for this pack', () => expect(button('Copy link')).toBeDefined());
  expect([...document.querySelectorAll('[role="dialog"]')].some((dialog) => dialog.textContent?.includes('Share your pull'))).toBe(true);
  expect(stats()?.packsOpened).toBe(1);
}, 30_000);

it('hides the app chrome from the tear through the summary, and brings it back when the pack is left', async () => {
  app = await mountedApp(preferences());
  await app.mount();
  expect(focusMode()).toBe(false);
  await reveal();
  expect(focusMode(), 'the reveal showed the chrome').toBe(true);
  expect(button('Settings').disabled, 'the reveal enabled Settings').toBe(true);
  await summary();
  expect(focusMode(), 'the summary brought the chrome back').toBe(true);
  // Focus mode is not "busy": the summary still leaves Settings and the set picker usable.
  expect(button('Settings').disabled).toBe(false);
  await app.interact(() => button('Next pack').click());
  await app.until('sealed pack is available again', () => expect(sealed()).not.toBeNull());
  expect(focusMode(), 'the packs screen kept the chrome hidden').toBe(false);
}, 30_000);

it('lets the X end a big pull\'s hold and leave, recording the pack once; nothing else gets past the hold', async () => {
  app = await mountedApp(preferences({ nextNonce: 22, pauseBigPulls: true }));
  await app.mount();
  await reveal();
  await app.interact(() => button('Skip opening animation').click());
  await app.until('skip stops on the big pull', () => expect($('.active-card-container')?.getAttribute('aria-busy')).toBe('true'));
  // The showcase: a ribbon in the top bar, above the card, and a halo behind it.
  // Its announcement reads as words, and says presses wait (they do nothing during the hold).
  expect($('.pack-top-bar .showcase-ribbon[role="status"]')?.textContent).toMatch(/^Big pull! [\d,]+ points\. Continue in a moment\.$/);
  expect($('.reveal-card .showcase-halo')).not.toBeNull();
  const area = $('.card-reveal-area')!;
  const card = progress();
  await app.interact(() => {
    area.click();
    press(area, area, area);
    press($('.active-card-container')!, area, area);
    $('.card-wrapper')!.click();
  });
  expect($('.active-card-container')?.getAttribute('aria-busy')).toBe('true');
  expect(progress(), 'a press got past the hold').toBe(card);
  expect(sealed()).toBeNull();
  expect(stats()?.packsOpened ?? 0).toBe(0);

  expect(button('Back to packs').disabled, 'the X is disabled during the hold').toBe(false);
  await app.interact(() => button('Back to packs').click());
  await app.until('the X leaves during the hold', () => expect(sealed()).not.toBeNull());
  expect($('.showcase-ribbon'), 'the celebration outlived the pack').toBeNull();
  expect($('.showcase-halo'), 'the celebration outlived the pack').toBeNull();
  expect($('.active-card-container')).toBeNull();
  expect(stats()?.packsOpened).toBe(1);
  expect(stats()?.highestPackCards).toHaveLength(5);
  // The hold's timers don't bring the pack back or record it again.
  await app.settle(4000);
  expect(sealed()).not.toBeNull();
  expect(document.querySelectorAll('.summary-card')).toHaveLength(0);
  expect(stats()?.packsOpened).toBe(1);
  const before = localStorage.getItem(STORAGE_KEYS.STATS);
  await app.reload();
  expect(localStorage.getItem(STORAGE_KEYS.STATS)).toBe(before);
  expect(sealed()).not.toBeNull();
}, 30_000);

it('holds the last pack\'s notices while a big pull is on show, and shows them all once it ends', async () => {
  // Nonce 21 has no big pull; the next pack, nonce 22, does.
  app = await mountedApp(preferences({ nextNonce: 21, pauseBigPulls: true }), { hallOfFame: [] });
  await app.mount();
  await reveal();
  await escape();
  await app.until('the first pack is kept', () => expect(toasts()).toContain('Pack kept'));
  await app.until('a fresh pack is ready', () => expect(sealed()).not.toBeNull());
  await reveal();
  const before = toasts();
  expect(before, 'a notice is up when the big pull lands').not.toBe('');
  await app.interact(() => button('Skip opening animation').click());
  await app.until('the big pull is on show', () => expect($('.showcase-ribbon')).not.toBeNull());
  // Gone the frame the ribbon shows, and nothing new shows over the showcase.
  expect(toasts()).toBe('');
  await app.settle(1500);
  expect($('.showcase-ribbon')).not.toBeNull();
  expect(toasts()).toBe('');
  // When it ends, the held notice comes back first, in full.
  await app.until('the showcase ends', () => expect($('.showcase-ribbon')).toBeNull());
  await app.until('the held notice shows', () => expect(toasts()).toBe(before));
}, 30_000);

it('keeps notices held between two big pulls that Skip shows back to back (#460)', async () => {
  // Nonce 973 leaves a notice behind; nonce 974 deals two big pulls, the last two cards.
  app = await mountedApp(preferences({ nextNonce: 973, pauseBigPulls: true }), { hallOfFame: [] });
  await app.mount();
  await reveal();
  await escape();
  await app.until('the first pack is kept', () => expect(toasts()).toContain('Pack kept'));
  await app.until('a fresh pack is ready', () => expect(sealed()).not.toBeNull());
  await reveal();
  // Every change to the ribbon and the notices, so a frame-long flash is caught.
  const frames: { ribbon: boolean; toast: string }[] = [];
  const observer = new MutationObserver(() => {
    const frame = { ribbon: !!$('.showcase-ribbon'), toast: toasts() };
    const last = frames[frames.length - 1];
    if (!last || last.ribbon !== frame.ribbon || last.toast !== frame.toast) frames.push(frame);
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  await app.interact(() => button('Skip opening animation').click());
  await app.until('the summary shows', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
  observer.disconnect();

  const showcases = frames.filter((frame, i) => frame.ribbon && !frames[i - 1]?.ribbon);
  expect(showcases, 'Skip showed both big pulls').toHaveLength(2);
  const first = frames.findIndex((frame) => frame.ribbon);
  const last = frames.length - 1 - [...frames].reverse().findIndex((frame) => frame.ribbon);
  expect(frames.slice(first, last + 1).filter((frame) => frame.toast), 'a notice showed between the showcases').toEqual([]);
  // The held notice comes back once they are over.
  await app.until('the held notice shows', () => expect(toasts()).toContain('Pack kept'));
}, 60_000);

it('still shows the save warning at once over a big pull, since it needs action (#460)', async () => {
  app = await mountedApp(preferences({ nextNonce: 22, pauseBigPulls: true }));
  await app.mount();
  await reveal();
  await app.interact(() => button('Skip opening animation').click());
  await app.until('the big pull is on show', () => expect($('.showcase-ribbon')).not.toBeNull());
  // Another tab saves a different player, as a browser tells the tabs that didn't write.
  localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '02'.repeat(32), name: 'Other tab', nextNonce: 0, createdAt: 1 }));
  await app.interact(() => window.dispatchEvent(new StorageEvent('storage', { key: 'brainrot-player-v1' })));
  expect($('.showcase-ribbon'), 'the showcase ended').not.toBeNull();
  expect($('.app > p[role="alert"].save-warning')?.textContent).toContain('This save changed in another tab');
}, 30_000);

it('leaves the summary with Escape, as Next pack does, without recording it again', async () => {
  app = await mountedApp(preferences());
  await app.mount();
  await reveal();
  await app.interact(() => button('Skip opening animation').click());
  await app.until('summary has all cards', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
  expect(button('Back to packs'), 'the summary has the pack\'s X').toBeDefined();
  expect($('.reveal-progress'), 'the summary shows a card count').toBeNull();
  await escape();
  await app.until('Escape leaves the summary', () => expect(sealed()).not.toBeNull());
  await app.settle(1000);
  expect(stats()?.packsOpened).toBe(1);
  expect(toasts(), 'a pack seen to the end said it was kept').not.toContain('Pack kept');
}, 30_000);

it('puts a torn pack back sealed when it is left before its ticket is spent', async () => {
  app = await mountedApp(preferences());
  await app.mount();
  await app.interact(() => {
    sealed()!.focus();
    sealed()!.click();
  });
  expect(button('Back to packs'), 'the torn pack has the pack\'s X').toBeDefined();
  await app.interact(() => button('Back to packs').click());
  await app.settle(2000);
  expect(sealed()).not.toBeNull();
  // The X went with the torn pack: focus lands on Open pack, never the page.
  expect(document.activeElement).toBe(sealed());
  expect(button('Back to packs')).toBeUndefined();
  expect($('.reveal-progress')).toBeNull();
  expect(stats()?.packsOpened ?? 0).toBe(0);
  expect(JSON.parse(localStorage.getItem('brainrot-player-v1')!).nextNonce, 'leaving before the tear landed spent a ticket').toBe(0);
  await reveal();
}, 30_000);

it('leaves a torn pack whose ticket is on its way at once, and records it once, face up, when it lands', async () => {
  app = await mountedApp(preferences(), { tickets: () => ({ delayMs: 4000 }) });
  await app.mount();
  await app.interact(() => {
    sealed()!.focus();
    sealed()!.click();
  });
  await app.until('the slow ticket says so', () => expect($('.pack-hint.is-waiting')).not.toBeNull());
  expect(focusMode()).toBe(true);
  await app.interact(() => button('Back to packs').click());
  expect(button('Back to packs'), 'the X stayed after leaving').toBeUndefined();
  expect(focusMode(), 'the packs screen kept the chrome hidden while the ticket mined').toBe(false);
  expect($('.pack-hint.is-waiting'), 'the pack still said it was opening').toBeNull();
  expect($('.pack-shell.is-cut'), 'the pack still looked torn').toBeNull();
  await app.until('leaving steps back over the pack\'s history entry', () =>
    expect((history.state as { brainrotPack?: boolean } | null)?.brainrotPack ?? false).toBe(false));
  // A second press, or Escape, while it lands does nothing more.
  await escape();
  expect(stats()?.packsOpened ?? 0).toBe(0);

  await app.until('the late pack is recorded', () => expect(stats()?.packsOpened).toBe(1));
  await app.until('the kept notice shows', () => expect(toasts()).toContain('Pack kept'));
  await app.settle(2000);
  expect(stats()?.packsOpened, 'the late pack was recorded twice').toBe(1);
  expect($('.reveal-progress'), 'the late pack opened over the packs screen').toBeNull();
  expect(sealed()).not.toBeNull();
}, 30_000);

describe('browser Back in a pack', () => {
  const packEntry = () => (history.state as { brainrotPack?: boolean } | null)?.brainrotPack === true;
  const back = () => app!.interact(() => history.back());

  it('leaves a reveal as the X does, and keeps one entry per pack', async () => {
    app = await mountedApp(preferences());
    const href = location.href;
    // jsdom keeps history across a file's tests, so the length is measured at the first pack.
    let length = 0;
    const pushes = vi.spyOn(history, 'pushState');
    await app.mount();
    expect(pushes, 'the packs screen added history').not.toHaveBeenCalled();

    for (const index of [0, 1]) {
      await reveal();
      expect(packEntry(), `pack ${index + 1} has no history entry`).toBe(true);
      if (index === 0) length = history.length;
      expect(history.length, `pack ${index + 1} stacked history`).toBe(length);
      expect(location.href, 'a pack changed the address').toBe(href);
      await app.interact(() => $('.card-wrapper')!.click());
      await back();
      await app.until('Back returns to the packs screen', () => expect(sealed()).not.toBeNull());
      expect(stats()?.packsOpened).toBe(index + 1);
      expect(stats()?.highestPackCards).toHaveLength(5);
      expect(packEntry()).toBe(false);
      expect(location.href).toBe(href);
    }
    expect(pushes).toHaveBeenCalledTimes(2);
    await app.until('the kept notice shows', () => expect(toasts()).toContain('Pack kept'));

    // Forward onto an old pack's entry reopens nothing.
    await app.interact(() => history.forward());
    await app.settle(1000);
    expect(sealed()).not.toBeNull();
    expect($('.reveal-progress')).toBeNull();
    expect(stats()?.packsOpened).toBe(2);
  }, 30_000);

  it('steps back over the entry when the X, Escape or the summary leaves, so Back then leaves the page', async () => {
    app = await mountedApp(preferences());
    let length = 0;
    await app.mount();
    for (const leave of ['X', 'Escape', 'Next pack']) {
      await reveal();
      expect(packEntry()).toBe(true);
      if (leave === 'X') length = history.length;
      expect(history.length, `the pack before ${leave} stacked history`).toBe(length);
      if (leave === 'X') await app.interact(() => button('Back to packs').click());
      else if (leave === 'Escape') await escape();
      else {
        await app.interact(() => button('Skip opening animation').click());
        await app.until('summary has all cards', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
        await app.interact(() => button('Next pack').click());
      }
      await app.until(`${leave} returns to the packs screen`, () => expect(sealed()).not.toBeNull());
      await app.until(`${leave} steps back over the pack's entry`, () => expect(packEntry()).toBe(false));
      expect(history.length, `${leave} stacked history`).toBe(length);
      expect(focusMode(), `${leave} kept the chrome hidden`).toBe(false);
    }
    expect(stats()?.packsOpened).toBe(3);
  }, 30_000);

  it('does not leave the summary from under its share sheet, as the summary\'s own buttons don\'t', async () => {
    app = await mountedApp(preferences());
    await app.mount(mockPoster);
    await reveal();
    const length = history.length;
    await summary();
    await app.interact(() => button('Share').click());
    await app.until('share sheet opens for this pack', () => expect(button('Copy link')).toBeDefined());
    await back();
    await app.until('the pack takes its entry back', () => expect(packEntry()).toBe(true));
    expect(history.length).toBe(length);
    expect(document.querySelectorAll('.summary-card'), 'Back left the summary under the sheet').toHaveLength(5);
    expect(sealed()).toBeNull();
    expect(focusMode()).toBe(true);

    // With the sheet closed, Back leaves the summary as before.
    await escape();
    await app.until('Escape closes the sheet', () => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(document.querySelectorAll('.summary-card')).toHaveLength(5);
    await back();
    await app.until('Back leaves the summary', () => expect(sealed()).not.toBeNull());
    expect(focusMode()).toBe(false);
    expect(stats()?.packsOpened).toBe(1);
  }, 30_000);

  it('steps back over a pack\'s entry the page was loaded on, so the first Back leaves the page', async () => {
    app = await mountedApp(preferences());
    // A reload while a pack was open: the page comes back on the pack's entry, with no pack.
    history.replaceState({ below: true }, '');
    history.pushState({ brainrotPack: true }, '');
    const length = history.length;
    await app.mount();
    await app.until('the load steps back over the old entry', () => expect(history.state).toEqual({ below: true }));
    expect(history.length).toBe(length);
    expect(sealed()).not.toBeNull();
    expect(focusMode()).toBe(false);

    // The next pack adds its own entry in the old one's place, and Back from it leaves it.
    await reveal();
    expect(packEntry()).toBe(true);
    expect(history.length, 'the pack stacked history over the old entry').toBe(length);
    await back();
    await app.until('Back returns to the packs screen', () => expect(sealed()).not.toBeNull());
    await app.until('Back lands below the pack', () => expect(history.state).toEqual({ below: true }));
    expect(stats()?.packsOpened).toBe(1);
  }, 30_000);
});
