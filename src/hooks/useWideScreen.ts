import { useSyncExternalStore } from 'react';

/** Where the wide layout starts: the same 900px as the media query in Toasts.css (the toast's top-right place). */
export const WIDE_SCREEN_QUERY = '(min-width: 900px)';

const subscribe = (onChange: () => void) => {
  const media = window.matchMedia(WIDE_SCREEN_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
};

/** True in the wide layout (900px and up), kept current as the window is resized or turned. */
export const useWideScreen = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(WIDE_SCREEN_QUERY).matches,
    () => false,
  );
