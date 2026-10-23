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
 * Fetch the card back the first reveal shows, unless the visitor saves data or is elsewhere. It waits
 * for the sealed pack's art, which the first screen needs more.
 */
export const warmUpFirstPack = (): void => {
  afterPackArt(() => whenShownAndIdle(() => {
    if (savingData() || !canOpenPack()) return;
    new Image().src = cardBackImage;
  }));
};
