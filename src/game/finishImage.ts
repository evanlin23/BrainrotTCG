import type { Finish } from '../engine';
import frameMaskUrl from '../assets/images/card-frame-mask.webp';
import { recolorFrame } from './frameRecolor';

export { recolorFrame } from './frameRecolor';

// Allow slow mobile loads without leaving a finish hidden indefinitely after a stalled request.
const IMAGE_LOAD_TIMEOUT_MS = 15_000;
const IMAGE_ENCODE_TIMEOUT_MS = 15_000;

const loadImage = (src: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
  const img = new Image();
  let settled = false;
  const settle = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    img.onload = null;
    img.onerror = null;
    if (error) reject(error);
    else resolve(img);
  };
  const timeout = setTimeout(() => settle(new Error(`Image load timed out: ${src}`)), IMAGE_LOAD_TIMEOUT_MS);
  img.onload = () => settle();
  img.onerror = () => settle(new Error(`Could not load ${src}`));
  img.src = src;
});

let frameMask: Promise<ImageData> | undefined;
const getFrameMask = (): Promise<ImageData> => frameMask ??= loadImage(frameMaskUrl).then((image) => {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}).catch((error) => {
  frameMask = undefined;
  throw error;
});

// Keep the 16 most recent full-size renders (a lossless PNG each) for reuse; held ones never count as spare.
export const MAX_CACHED_FINISHES = 16;

interface CachedFinish {
  image: Promise<string>;
  url?: string;
  /** Mounted images (or exports) still using this render; it is never revoked while above zero. */
  holders: number;
}

const cache = new Map<string, CachedFinish>();

/** Drop the least recently used renders nothing holds until the cache is back within its bound. */
const trimCache = () => {
  for (const [key, entry] of cache) {
    if (cache.size <= MAX_CACHED_FINISHES) return;
    if (entry.holders > 0) continue;
    cache.delete(key);
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
};

// Each render holds a full-size canvas, a copy of its pixels and a PNG encode at once; a phone opening a
// screen of finished cards must not start them all together (#226). Queued renders wait their turn
// in order, and their load deadline starts only once they run.
export const MAX_CONCURRENT_RENDERS = 2;

let running = 0;
const waiting: (() => void)[] = [];

/** Hands the slot to the next queued render, or frees it. */
const nextRender = () => {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
};

/**
 * Runs `render` now when a slot is free, otherwise once one is. A queued render that nothing wants
 * by its turn (`wanted` is false) gives its slot straight on and rejects without starting.
 */
const limitRenders = <T>(render: () => Promise<T>, wanted: () => boolean): Promise<T> => {
  const run = () => new Promise<T>((resolve) => resolve(render())).finally(nextRender);
  if (running < MAX_CONCURRENT_RENDERS) {
    running += 1;
    return run();
  }
  return new Promise<void>((resolve) => waiting.push(resolve)).then(() => {
    if (wanted()) return run();
    nextRender();
    throw new Error('Finish render no longer needed');
  });
};

const renderFinish = (src: string, finish: Finish): Promise<string> =>
  Promise.all([loadImage(src), getFrameMask()]).then(async ([image, mask]) => {
    const canvas = document.createElement('canvas');
    canvas.width = mask.width;
    canvas.height = mask.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    recolorFrame(pixels.data, mask.data, finish);
    ctx.putImageData(pixels, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Finish encoding timed out: ${src}`)), IMAGE_ENCODE_TIMEOUT_MS);
      try {
        canvas.toBlob((png) => {
          clearTimeout(timeout);
          if (png) resolve(png);
          else reject(new Error('Finish render failed'));
        }, 'image/png');
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
    return URL.createObjectURL(blob);
  });

export interface FinishedCardImageHold {
  /** The finished image's URL (the plain `src` when there is no finish). */
  image: Promise<string>;
  /** Call once nothing displays the URL any more; the render may then be evicted and revoked. */
  release: () => void;
}

const noop = () => {};

/**
 * One cached lossless image per card/finish, shared by every screen and the PNG exporter. The URL
 * stays valid until `release`: call it only after the image showing it has unmounted or moved on.
 */
export const holdFinishedCardImage = (src: string, finish?: Finish | null): FinishedCardImageHold => {
  if (!finish) return { image: Promise.resolve(src), release: noop };
  const key = `${finish}:${src}`;
  let entry = cache.get(key);
  if (entry) {
    // Most recently used goes last, so trimming reaches it last.
    cache.delete(key);
    cache.set(key, entry);
  } else {
    const created: CachedFinish = { image: Promise.resolve(''), holders: 0 };
    // Released before its turn came: drop it from the cache now, so a later request starts afresh.
    const wanted = () => {
      if (created.holders > 0) return true;
      if (cache.get(key) === created) cache.delete(key);
      return false;
    };
    created.image = limitRenders(() => renderFinish(src, finish), wanted).then((url) => {
      created.url = url;
      // Evicted while rendering, with nobody waiting: nothing will ever show it.
      if (cache.get(key) !== created && created.holders === 0) URL.revokeObjectURL(url);
      return url;
    }, (error: unknown) => {
      if (cache.get(key) === created) cache.delete(key);
      throw error;
    });
    entry = created;
    cache.set(key, entry);
  }
  const held = entry;
  held.holders += 1;
  trimCache();
  let released = false;
  return {
    image: held.image,
    release: () => {
      if (released) return;
      released = true;
      held.holders -= 1;
      if (held.holders === 0) trimCache();
    },
  };
};
