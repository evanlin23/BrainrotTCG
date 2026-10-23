/**
 * Cloudflare Web Analytics, as Cloudflare Pages' automatic setup adds it to production
 * (docs/HOSTING.md#web-analytics). Our build adds nothing; Pages injects one beacon tag before each
 * page's </body> on the way out. scripts/deploy_contract.py strips exactly that tag before comparing
 * served pages with the sealed ones, the production smoke accepts the beacon script, and browser
 * checks against the real site answer the beacon and its reporting endpoint with inert stand-ins
 * (tests/browser/support.ts), so they aren't counted as visits.
 */

/** The beacon script Pages' tag loads (developers.cloudflare.com/web-analytics/faq/). */
export const BEACON_URL = 'https://static.cloudflareinsights.com/beacon.min.js';

/** Where the beacon reports page views (developers.cloudflare.com/web-analytics/faq/). */
export const RUM_URL = 'https://cloudflareinsights.com/cdn-cgi/rum';

/**
 * The tag Pages injects just before </body>, byte for byte as production serves it, with a fake
 * token. Tests only; deploy_contract.py's BEACON_TAG matches the same shape.
 */
export const pagesBeaconTag = (token: string): string =>
  `<!-- Cloudflare Pages Analytics --><script defer src='${BEACON_URL}' data-cf-beacon='{"token": "${token}"}'></script>`
  + '<!-- Cloudflare Pages Analytics -->';
