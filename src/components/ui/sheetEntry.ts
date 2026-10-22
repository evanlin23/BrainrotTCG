import { createContext, type ComponentType } from 'react';

/**
 * True while a lazily loaded screen replaces the loading placeholder that DeferredSheet already put
 * on screen: the screen's Sheet then appears in place instead of playing its entrance a second time.
 */
export const SheetSettledContext = createContext(false);

/** Fetches a lazy screen; `loaded` holds it once it has arrived, so reopening needs no placeholder. */
export type SheetLoad<P> = (() => Promise<{ default: ComponentType<P> }>) & { loaded?: ComponentType<P> };

/**
 * Removes any broken stylesheet links (`sheet === null`) in real browser environments.
 * Ignored in jsdom where external stylesheets are not fetched, unless `force` is true.
 */
export const purgeBrokenStylesheets = (force = false) => {
  if (typeof document === 'undefined') return;
  const isJsdom = typeof navigator !== 'undefined' && navigator.userAgent.includes('jsdom');
  if (isJsdom && !force) return;
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    if (link.sheet === null) {
      link.remove();
    }
  }
};

/**
 * Wraps a screen's dynamic import so warming it up (on hover, focus or press) and opening it share one
 * request. A failed request is forgotten, so opening or Retry asks again.
 */
export const sheetLoader = <M extends { default: unknown }>(importer: () => Promise<M>) => {
  let pending: Promise<M> | null = null;
  const load = Object.assign(
    () =>
      (pending ??= importer().then(
        (module) => {
          if (typeof document !== 'undefined') {
            const isJsdom = typeof navigator !== 'undefined' && navigator.userAgent.includes('jsdom');
            if (!isJsdom) {
              for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
                if (link.sheet === null) {
                  link.remove();
                  throw new Error(`Stylesheet failed to load: ${link.href}`);
                }
              }
            }
          }
          load.loaded = module.default;
          return module;
        },
        (error: unknown) => {
          pending = null;
          purgeBrokenStylesheets();
          throw error;
        },
      )),
    { loaded: undefined as M['default'] | undefined },
  );
  return load;
};
