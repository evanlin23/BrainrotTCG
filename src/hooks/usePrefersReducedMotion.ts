import { useSyncExternalStore } from 'react';
import { prefersReducedMotion, REDUCED_MOTION_QUERY } from '../utils/motion';

const subscribe = (onChange: () => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
};

/**
 * The device's reduced-motion setting, kept current: turning it on mid-pack stops the tilt and the
 * celebration's bounce straight away. (framer-motion's useReducedMotion reads it once per mount.)
 */
export const usePrefersReducedMotion = (): boolean =>
  useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
