/** Which card art this build may request. Browser-side: it reads the page's own address. */
import { isCatalogCardImage } from '../content/art';

/** A 1px transparent GIF: what an img shows (or a poster draws) in place of art this build won't request. */
export const BLANK_CARD_ART = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * Whether a card's stored image string may be requested. Cards from the catalog always can. An unknown
 * historical card (kept from an older build or an imported backup, never rewritten) carries whatever image
 * string it was saved with, so it only counts when the browser would read it as an http(s) address on this
 * page's own origin, such as the old `/BrainrotTCG/assets/...` paths. Another host, a protocol-relative or
 * backslash-disguised address, credentials in the address, and schemes such as data:, blob:, file: or
 * javascript: are all refused, so an imported save can't make the page contact a third party.
 * The address is resolved with the same URL parser and base an img element would use.
 */
export const isApprovedCardArt = (image: string): boolean => {
  if (isCatalogCardImage(image)) return true;
  if (typeof document === 'undefined' || typeof location === 'undefined') return false;
  try {
    const url = new URL(image, document.baseURI);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.origin === location.origin && !url.username && !url.password;
  } catch {
    return false;
  }
};
