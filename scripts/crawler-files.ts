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

/**
 * The 404 page (404.html) beside index.html (#1292).
 * On Cloudflare Pages, a root 404.html serves a real HTTP 404 for missing assets and unknown paths
 * instead of falling back to the 200 homepage SPA fallback. Links home to base.
 */
export const notFoundHtml = (base: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found · Brainrot TCG</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121114;color:#f2efe9;font:17px/1.5 system-ui,sans-serif;padding:24px;box-sizing:border-box}
main{max-width:26rem;text-align:center}
h1{font-size:1.6rem;margin:0 0 .5rem}
p{color:#b6b0ba;margin:0 0 1.25rem}
a{display:inline-block;padding:.75rem 1.5rem;background:#ffd23f;color:#121114;border-radius:10px;text-decoration:none;font-weight:600}
a:hover,a:focus-visible{background:#ffe072}
</style>
</head>
<body>
<main>
<h1>Page not found</h1>
<p>This page doesn't exist, or has been moved.</p>
<a href="${base}">Back to Brainrot TCG</a>
</main>
</body>
</html>
`;
