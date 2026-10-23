/**
 * Work done ahead of the first pack, once the page is shown and idle: the reveal doesn't wait for
 * the card back to download.
 */
import cardBackImage from '../assets/images/card_back.webp';
import { whenIdle } from './idle';
import { afterPackArt } from './packArt';
import { isLinkHash, pageForHash } from './route';

const hidden = () => document.visibilityState === 'hidden';

/** Run `task` once the tab is visible and idle. A tab opened in the background waits until it is shown. */
export const whenShownAndIdle = (task: () => void): void => {
  const attempt = () => {
    if (hidden()) {
      document.addEventListener('visibilitychange', attempt, { once: true });
      return;
    }
    whenIdle(() => (hidden() ? attempt() : task()));
  };
  attempt();
};

/** The visitor asked the browser to save data (Network Information API; Chromium only). */
const savingData = () => (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

/** The page showing can open a pack: Open, not another page or a shared pull or profile. */
const canOpenPack = () => pageForHash(location.hash) === null && !isLinkHash(location.hash);

/**
 * Run `task` ahead of the first pack: once the sealed pack's art has settled and the page is shown and
 * idle, unless the visitor saves data or is on a page or link that can't open a pack. It waits for the
 * sealed pack's art, which the first screen needs more.
 */
export const warmUpForPack = (task: () => void): void => {
  afterPackArt(() => whenShownAndIdle(() => {
    if (savingData() || !canOpenPack()) return;
    task();
  }));
};

/**
 * Fetch the card back the first reveal shows, and run `alsoWarm` (other code the first reveal needs,
 * which the caller loads) at the same time, under the same conditions as `warmUpForPack`.
 */
export const warmUpFirstPack = (alsoWarm: () => void = () => {}): void => {
  warmUpForPack(() => {
    new Image().src = cardBackImage;
    alsoWarm();
  });
};

/**
 * Fetch the Argon2 chunk once the page is idle, on every page and whatever the visitor's data setting:
 * it is what the main-thread mining fallback uses (a ticket worker that can't load, the Best cards
 * rebuild, verifying a pull), and a player who has gone offline can't fetch it then. On a page that can
 * open a pack it waits for the sealed pack's art like the card back does. A failed fetch is ignored: the
 * mining that needs it tries again.
 */
export const warmUpArgon2 = (): void => {
  const warm = () => whenIdle(() => { import('../engine/argon2').catch(() => {}); });
  if (canOpenPack()) afterPackArt(warm);
  else warm();
};
