import { useSyncExternalStore } from 'react';
import { prefersReducedMotion, subscribeReducedMotion } from '../utils/motion';

/**
 * Whether motion is reduced, kept current: the Motion setting or the device's reduced-motion setting
 * changing mid-pack stops the tilt and the celebration's bounce straight away. (framer-motion's
 * useReducedMotion reads the device once per mount.)
 */
export const usePrefersReducedMotion = (): boolean =>
  useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
