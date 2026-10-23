import type { MotionSetting } from '../types';

/** The device's request for less motion. Effects check it on every call, so a change mid-session applies at once. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * The player's Motion setting. "reduced" behaves as if the device asked for less motion (the CSS
 * reads `data-motion` on <html>, scripts read prefersReducedMotion); "auto" leaves it to the device.
 * App keeps it in step with Settings and main.tsx applies the saved one before the first render.
 */
let motionSetting: MotionSetting = 'auto';
const listeners = new Set<() => void>();

export const setMotionSetting = (next: MotionSetting): void => {
  if (typeof document !== 'undefined') {
    const { dataset } = document.documentElement;
    if (next === 'reduced' && dataset.motion !== 'reduced') dataset.motion = 'reduced';
    else if (next !== 'reduced' && dataset.motion !== undefined) delete dataset.motion;
  }
  if (next === motionSetting) return;
  motionSetting = next;
  listeners.forEach((listener) => listener());
};

const deviceReducesMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches;

/** Whether motion should be calm now: the Motion setting says so, or the device does. */
export const prefersReducedMotion = (): boolean => motionSetting === 'reduced' || deviceReducesMotion();

/** Calls onChange when the Motion setting or the device's setting changes. */
export const subscribeReducedMotion = (onChange: () => void): (() => void) => {
  listeners.add(onChange);
  const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION_QUERY) : null;
  media?.addEventListener('change', onChange);
  return () => {
    listeners.delete(onChange);
    media?.removeEventListener('change', onChange);
  };
};

/** A short haptic buzz, skipped where vibration is missing or motion is reduced. */
export const buzz = (pattern: number | number[]): void => {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function' || prefersReducedMotion()) return;
  navigator.vibrate(pattern);
};
