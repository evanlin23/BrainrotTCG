/**
 * Cloudflare Web Analytics, added by our build so production serves exactly the bytes the deploy
 * sealed (docs/HOSTING.md#web-analytics). Cloudflare's automatic setup injected the beacon on the
 * way out instead, so no served page matched its sealed copy.
 *
 * The deploy passes the repository variable CLOUDFLARE_ANALYTICS_TOKEN to its production build only
 * (scripts/deploy_contract.py checks no other step or workflow names it). Unset or empty, the plugin
 * has no hooks, so the build is byte for byte what it was without analytics. Set, index.html (the
 * only page players stay on: p/ and s/ pages and the old address's pages forward straight to it)
 * gets Cloudflare's snippet once, before </body>. The value lands inside HTML, so anything but a
 * site token fails the build.
 */
import type { Plugin } from 'vite';

/** Cloudflare's beacon, as its snippet loads it (developers.cloudflare.com/web-analytics/faq/). */
export const BEACON_URL = 'https://static.cloudflareinsights.com/beacon.min.js';

/**
 * A Web Analytics site token: 32 lowercase hex digits, as the site_token and snippet examples in
 * Cloudflare's API reference show them (developers.cloudflare.com/api/resources/rum/). Its docs give
 * no other format, so this is as wide as the check goes.
 */
const TOKEN = /^[0-9a-f]{32}$/;

/** The token, or null when the variable is unset or empty. Throws on anything else. */
export const analyticsToken = (value: string | undefined): string | null => {
  if (value === undefined || value === '') return null;
  if (!TOKEN.test(value)) {
    throw new Error('CLOUDFLARE_ANALYTICS_TOKEN must be the 32 lowercase hex digits of a Cloudflare Web Analytics site token '
      + "(the \"token\" in the snippet's data-cf-beacon), with nothing around it");
  }
  return value;
};

/** Cloudflare's JS snippet (developers.cloudflare.com/web-analytics/get-started/). */
export const analyticsSnippet = (token: string): string =>
  `<script defer src="${BEACON_URL}" data-cf-beacon='{"token": "${token}"}'></script>`;

/** The page with the snippet just before its one </body>. */
export const withAnalytics = (html: string, token: string): string => {
  const end = html.indexOf('</body>');
  if (end < 0 || html.indexOf('</body>', end + 1) >= 0) throw new Error('cloudflare-analytics: index.html must have exactly one </body>');
  if (html.includes(BEACON_URL)) throw new Error('cloudflare-analytics: index.html already loads the beacon');
  return `${html.slice(0, end)}${analyticsSnippet(token)}\n${html.slice(end)}`;
};

export const cloudflareAnalytics = (value = process.env.CLOUDFLARE_ANALYTICS_TOKEN): Plugin => {
  const token = analyticsToken(value);
  if (token === null) return { name: 'cloudflare-analytics' };
  return {
    name: 'cloudflare-analytics',
    apply: 'build',
    transformIndexHtml: { order: 'post', handler: (html) => withAnalytics(html, token) },
  };
};
