import { STORAGE_KEYS } from '../../constants';
import { prefersReducedMotion } from '../../utils/motion';
import { readSettings } from '../../utils/settings';
import { getStoredData } from '../../utils/storage';

/** The confetti library is only needed once a card is flipped, so it stays out of the first load. */
export const loadConfetti = () => import('./confettiEffects');

/**
 * Fetch the confetti library ahead of the first flip, for a player whose settings and device would
 * burst. Under reduced motion, or with particles off, nothing bursts, so nothing is fetched. A failed
 * load is ignored: the reveal tries again at the flip.
 */
export const warmConfetti = (): void => {
  if (!readSettings(getStoredData<unknown>(STORAGE_KEYS.SETTINGS, null)).particlesEnabled || prefersReducedMotion()) return;
  loadConfetti().catch(() => {});
};
