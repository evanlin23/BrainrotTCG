/**
 * How long a toast stays up (WCAG 2.2.1: time to read, decide and tap, not a glance), single and
 * grouped. Short enough that it is not sitting over the game, since it can also be swiped away. Kept
 * here so browser specs can read the same numbers the component uses.
 */
export const TOAST_MS = 5000;
export const GROUPED_TOAST_MS = 6000;
/**
 * A toast on screen this long has been seen: when a sheet, page or pack then takes the screen it is
 * let go, instead of coming back with its full time afterwards.
 */
export const TOAST_SEEN_MS = 1500;
