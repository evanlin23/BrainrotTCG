import { test, expect, type Page } from '@playwright/test';
import { settle } from './axe-scan';
import { holdTickets, monitor } from './support';

/**
 * The Motion setting in Settings (#765): Auto follows the device's reduced-motion setting, live, and
 * Reduced keeps the game calm whatever the device says. The stylesheets' motion tokens are the signal
 * read here (--dur is 0ms exactly when reduced motion applies), and the pack reveals in keyboard-reveal
 * cover what each mode does to a pack. Older saves have no motion value and read as Auto.
 */

const SETTINGS_KEY = 'brainrot-settings-v1';

interface Stored { effectsVolume?: number; particlesEnabled?: boolean; pauseBigPulls?: boolean; cardBack?: string; motion?: string; showDraftSets?: boolean }

/** Opens Settings with `stored` as the saved settings (or none), and returns the Motion choices. */
async function openSettings(page: Page, baseURL: string, stored: unknown) {
  const origin = new URL(baseURL).origin;
  const errors = await monitor(page, baseURL);
  if (stored !== undefined) {
    await page.addInitScript(({ key, stored, origin }) => {
      if (window.location.origin !== origin || sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      try { localStorage.setItem(key, typeof stored === 'string' ? stored : JSON.stringify(stored)); } catch { /* storage blocked */ }
    }, { key: SETTINGS_KEY, stored, origin });
  }
  await page.goto('./#/settings');
  const main = page.getByRole('main', { name: 'Settings', exact: true });
  const group = main.getByRole('radiogroup', { name: 'Motion', exact: true });
  await expect(group).toBeVisible();
  return { errors, main, group, auto: group.getByRole('radio', { name: 'Auto', exact: true }), reduced: group.getByRole('radio', { name: 'Reduced', exact: true }) };
}

/** The page's own reading of the setting: the attribute and whether the stylesheets zero their durations. */
const calm = (page: Page) => page.evaluate(() => ({
  attribute: document.documentElement.dataset.motion ?? null,
  // Through a property the stylesheets' blanket duration rule doesn't touch, because the built token is 0s, not 0ms.
  zeroed: (() => {
    const probe = document.body.appendChild(document.createElement('div'));
    probe.style.transitionDelay = 'var(--dur)';
    const duration = getComputedStyle(probe).transitionDelay;
    probe.remove();
    return parseFloat(duration) === 0;
  })(),
}));

const stored = (page: Page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null') as Stored | null, SETTINGS_KEY);

test('Auto follows the device live, and Reduced holds without the device asking', async ({ page, baseURL }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const { errors, auto, reduced } = await openSettings(page, baseURL!, undefined);
  await expect(auto).toHaveAttribute('aria-checked', 'true');
  await expect(reduced).toHaveAttribute('aria-checked', 'false');
  expect(await calm(page)).toEqual({ attribute: null, zeroed: false });

  // Auto: the device's change applies at once, in both directions, with nothing touched in the app.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await calm(page)).toEqual({ attribute: null, zeroed: true });
  await expect(auto).toHaveAttribute('aria-checked', 'true');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await calm(page)).toEqual({ attribute: null, zeroed: false });

  // Reduced: calm with the device allowing motion, and it stays so when the device allows or asks.
  await reduced.click();
  await expect(reduced).toHaveAttribute('aria-checked', 'true');
  await expect(auto).toHaveAttribute('aria-checked', 'false');
  expect(await calm(page)).toEqual({ attribute: 'reduced', zeroed: true });
  await expect.poll(() => stored(page)).toMatchObject({ motion: 'reduced' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await calm(page)).toEqual({ attribute: 'reduced', zeroed: true });

  // Back to Auto: the device decides again.
  await auto.click();
  await expect(auto).toHaveAttribute('aria-checked', 'true');
  expect(await calm(page)).toEqual({ attribute: null, zeroed: false });
  await expect.poll(() => stored(page)).toMatchObject({ motion: 'auto' });
  expect(errors).toEqual([]);
});

test('Reduced is kept on reload and is applied before the app first renders', async ({ page, baseURL }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // The pack screen under Settings mines the next pack's ticket and then preloads its cards' art with detached
  // `new Image()`s, which settle() and document.images can't see. When mining ends within a few ms of the reload
  // those requests start in the old document and the reload cancels them, so the monitor reports ERR_ABORTED.
  // Holding the ticket worker means that preload never starts, whatever the timing; this spec doesn't mine.
  await holdTickets(page);
  // Mutation records arrive in the order they happened, so each attribute write can be placed
  // before or after the first thing React draws into #root.
  await page.addInitScript(() => {
    const seen = window as unknown as { motionSetAt: string[] };
    seen.motionSetAt = [];
    let drawn = false;
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') seen.motionSetAt.push(`${(record.target as HTMLElement).dataset.motion ?? 'none'}:${drawn ? 'after-draw' : 'before-draw'}`);
        // index.html ships a "Loading…" line in #root; the app has drawn once anything else lands.
        else if (record.target instanceof HTMLElement && record.target.id === 'root'
          && Array.from(record.addedNodes).some((node) => !(node instanceof HTMLElement && node.classList.contains('boot-status')))) drawn = true;
      }
    // The document, because <html> doesn't exist yet when this script runs.
    }).observe(document, { attributes: true, childList: true, subtree: true, attributeFilter: ['data-motion'] });
  });
  const { errors, reduced } = await openSettings(page, baseURL!, undefined);
  await reduced.click();
  await expect.poll(() => stored(page)).toMatchObject({ motion: 'reduced' });

  // Reloading cancels card art still downloading, which the monitor reports. The pack screen stays mounted
  // under Settings, so wait on what the page reports: every image in the page that is loading has loaded or failed.
  await settle(page);
  // settle() leaves lazy images alone, since an unstarted one never loads; one in view has started, so wait for it.
  await page.evaluate(() => Promise.all(Array.from(document.images)
    .filter((image) => !image.complete && image.getBoundingClientRect().bottom > 0 && image.getBoundingClientRect().top < innerHeight)
    .map((image) => new Promise<void>((resolve) => {
      image.addEventListener('load', () => resolve(), { once: true });
      image.addEventListener('error', () => resolve(), { once: true });
    }))));
  await page.reload();
  const again = page.getByRole('main', { name: 'Settings', exact: true }).getByRole('radiogroup', { name: 'Motion', exact: true });
  await expect(again.getByRole('radio', { name: 'Reduced', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(await calm(page)).toEqual({ attribute: 'reduced', zeroed: true });
  expect(await page.evaluate(() => (window as unknown as { motionSetAt: string[] }).motionSetAt), 'the saved choice applied after the app drew').toEqual(['reduced:before-draw']);
  expect(errors).toEqual([]);
});

test('choosing a motion setting leaves every other setting as it was, and older saves read as Auto', async ({ page, baseURL }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const before: Stored = { effectsVolume: 0.35, particlesEnabled: false, pauseBigPulls: false, showDraftSets: true, cardBack: 'default' };
  const { errors, auto, reduced } = await openSettings(page, baseURL!, before);
  await expect(auto).toHaveAttribute('aria-checked', 'true');
  expect(await stored(page), 'reading the settings must not rewrite them').toEqual(before);
  await reduced.click();
  await expect.poll(() => stored(page)).toEqual({ ...before, motion: 'reduced' });
  await expect(page.getByRole('switch', { name: 'Particles', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('slider', { name: 'Sound effects', exact: true })).toHaveValue('35');
  expect(errors).toEqual([]);
});

test('a motion value it does not know reads as Auto and is not kept', async ({ page, baseURL }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const { errors, auto, reduced } = await openSettings(page, baseURL!, { effectsVolume: 0.5, motion: 'wobbly' });
  await expect(auto).toHaveAttribute('aria-checked', 'true');
  await expect(reduced).toHaveAttribute('aria-checked', 'false');
  expect(await calm(page)).toEqual({ attribute: null, zeroed: false });
  await reduced.click();
  await expect.poll(() => stored(page)).toEqual({ effectsVolume: 0.5, particlesEnabled: true, pauseBigPulls: true, motion: 'reduced' });
  expect(errors).toEqual([]);
});

test('the Motion choices are one radio group: one Tab stop, and the arrow keys move and apply the choice', async ({ page, baseURL }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const { errors, group, auto, reduced } = await openSettings(page, baseURL!, undefined);
  await expect(auto).toHaveAttribute('tabindex', '0');
  await expect(reduced).toHaveAttribute('tabindex', '-1');

  // Tab from the chosen one leaves the group; Shift+Tab comes back to it, not to the other choice.
  await auto.focus();
  await page.keyboard.press('Tab');
  await expect(group.locator(':focus')).toHaveCount(0);
  await page.keyboard.press('Shift+Tab');
  await expect(auto).toBeFocused();

  await page.keyboard.press('ArrowRight');
  await expect(reduced).toBeFocused();
  await expect(reduced).toHaveAttribute('aria-checked', 'true');
  await expect(reduced).toHaveAttribute('tabindex', '0');
  await expect(auto).toHaveAttribute('tabindex', '-1');
  expect(await calm(page)).toEqual({ attribute: 'reduced', zeroed: true });
  await expect.poll(() => stored(page)).toMatchObject({ motion: 'reduced' });

  // The arrows wrap, and any of the four moves the choice.
  await page.keyboard.press('ArrowDown');
  await expect(auto).toBeFocused();
  await expect(auto).toHaveAttribute('aria-checked', 'true');
  expect(await calm(page)).toEqual({ attribute: null, zeroed: false });
  await page.keyboard.press('ArrowLeft');
  await expect(reduced).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(auto).toBeFocused();
  await expect.poll(() => stored(page)).toMatchObject({ motion: 'auto' });
  expect(errors).toEqual([]);
});
