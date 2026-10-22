import type { Finish } from '../engine';

/** Built card images (see `npm run cards`), resolved through Vite so they get hashed URLs. */
const CARD_IMAGES = import.meta.glob('./sets/*/cards/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export const cardImageUrl = (setId: string, cardId: string): string =>
  CARD_IMAGES[`./sets/${setId}/cards/${cardId}.webp`] ?? '';

const CATALOG_IMAGES = new Set(Object.values(CARD_IMAGES));

/** True for the art this build itself ships for a card, whatever address the bundler gave it. */
export const isCatalogCardImage = (image: string): boolean => CATALOG_IMAGES.has(image);

/** Pre-rendered collection finishes: normal image loading, with no client-side canvas work. */
const FINISH_THUMBS = import.meta.glob('./sets/*/finish-thumbs/*.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const FINISH_THUMBS_BY_IMAGE = new Map<string, Partial<Record<Finish, string>>>();
for (const [path, image] of Object.entries(CARD_IMAGES)) {
  const thumbs: Partial<Record<Finish, string>> = {};
  for (const finish of ['SILVER', 'GOLD', 'PLATINUM', 'DIAMOND'] as const) {
    const thumb = FINISH_THUMBS[path.replace('/cards/', '/finish-thumbs/').replace(/\.webp$/, `.${finish.toLowerCase()}.webp`)];
    if (thumb) thumbs[finish] = thumb;
  }
  FINISH_THUMBS_BY_IMAGE.set(image, thumbs);
}

export const cardFinishThumbUrl = (image: string, finish?: Finish | null): string | undefined =>
  finish ? FINISH_THUMBS_BY_IMAGE.get(image)?.[finish] : undefined;

/** Each set's booster pack wrapper, also built by `npm run cards`. */
const PACK_IMAGES = import.meta.glob('./sets/*/pack.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export const packImageUrl = (setId: string): string => PACK_IMAGES[`./sets/${setId}/pack.webp`] ?? '';

/** A small copy of each wrapper for the pack picker, which shows them all at once. */
const PACK_THUMBS = import.meta.glob('./sets/*/pack-thumb.webp', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export const packThumbUrl = (setId: string): string => PACK_THUMBS[`./sets/${setId}/pack-thumb.webp`] ?? packImageUrl(setId);
