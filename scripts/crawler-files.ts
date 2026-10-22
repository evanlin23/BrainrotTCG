/**
 * The site's public address, and the robots.txt and sitemap.xml a build writes beside index.html
 * (#801). Production is Cloudflare Pages at CANONICAL_SITE_URL (docs/HOSTING.md). The deploy passes
 * the address it publishes to as SITE_URL (a custom domain, or GitHub Pages while Cloudflare isn't
 * ready); a build without SITE_URL names production, so index.html's checked-in tags already do.
 *
 * The sitemap lists only stable public pages: the app itself. Shared pulls, profiles and sets are
 * #/ routes inside it or noindex preview pages (p/, s/), so none of them belong there. Staging serves
 * these same files; its page asks not to be indexed (src/game/staging.ts) and the sitemap names only
 * production's address.
 */

export const CANONICAL_SITE_URL = 'https://brainrottcg.pages.dev/';

/** SITE_URL ending in exactly one /, or production's address when it isn't set. */
export const siteFromEnv = (siteUrl: string | undefined): string =>
  siteUrl ? `${siteUrl.replace(/\/+$/, '')}/` : CANONICAL_SITE_URL;

/** The pages the sitemap lists, relative to the site's address ('' is the app itself). */
export const SITEMAP_PAGES: readonly string[] = [''];

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Lets every crawler in and points them at the sitemap. */
export const robotsTxt = (site: string): string => `User-agent: *\nAllow: /\n\nSitemap: ${site}sitemap.xml\n`;

export const sitemapXml = (site: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${SITEMAP_PAGES.map((page) => `  <url><loc>${xml(site + page)}</loc></url>`).join('\n')}
</urlset>
`;
