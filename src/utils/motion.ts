/** The device's request for less motion. Effects check it on every call, so a change mid-session applies at once. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches;

/** A short haptic buzz, skipped where vibration is missing or the device asks for less motion. */
export const buzz = (pattern: number | number[]): void => {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function' || prefersReducedMotion()) return;
  navigator.vibrate(pattern);
};
