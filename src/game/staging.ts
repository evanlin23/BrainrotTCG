/**
 * Staging (docs/HOSTING.md#staging). Once the owner turns it on, the deploy publishes each sealed
 * build to a Cloudflare Pages preview address first (`staging.<project>.pages.dev`), checks it there,
 * then publishes the very same files to production. A build can't know where it will be served, so
 * it decides here, at run time: on a subdomain of VITE_STAGING_HOST_SUFFIX (the project's pages.dev
 * host, set by the deploy) it is staging. Production (that host itself, or a custom domain) and every
 * other address are not.
 *
 * A preview subdomain is its own origin, so its saves never mix with the real game's. Staging also:
 * - shows a banner and asks search engines not to index it (Cloudflare sends noindex for previews too);
 * - sends nothing to the Hall of Fame (share.ts) and takes no save from the old address (move.ts),
 *   whose pages only hand saves to the production origin anyway.
 */

/** True when `hostname` is a subdomain of `suffix` (a pages.dev project host). */
export const isStagingHost = (hostname: string, suffix: string): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const base = suffix.toLowerCase().replace(/^\.+|\.+$/g, '');
  return base !== '' && host.endsWith(`.${base}`) && host.length > base.length + 1;
};

export const isStaging = (): boolean =>
  typeof window !== 'undefined' && isStagingHost(window.location.hostname, import.meta.env.VITE_STAGING_HOST_SUFFIX ?? '');

export const STAGING_NOTE = 'Staging: a test copy of the next release. Saves here are separate from the real game, and nothing is sent to the Hall of Fame.';

/** On staging, ask crawlers not to index the page. Returns whether this is staging. */
export const markStaging = (doc: Document = document): boolean => {
  if (!isStaging()) return false;
  if (!doc.querySelector('meta[name="robots"]')) {
    const meta = doc.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    doc.head.appendChild(meta);
  }
  return true;
};
