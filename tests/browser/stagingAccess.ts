/*
 * Cloudflare Access on the staging address (docs/HOSTING.md#staging).
 *
 * The project's Access app covers its preview deployments, staging included. With the repository
 * secrets CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET set, the staging checks send that service
 * token's headers on every request to the staging origin, and to no other origin. Access in strict
 * mode returns no CF_Authorization cookie and ignores one sent back, so every request carries the
 * headers rather than a session cookie
 * (https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/).
 *
 * With neither secret, or no STAGING_URL, nothing here sends anything.
 */

export const ACCESS_HELP = 'docs/HOSTING.md#staging';

export interface StagingAccess {
  /** The staging origin, the only one the headers go to. */
  origin: string;
  headers: Record<string, string>;
}

type Env = Record<string, string | undefined>;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The staging origin and the token's headers, or null when STAGING_URL or both secrets are unset. */
export function stagingAccess(env: Env = process.env): StagingAccess | null {
  const id = env.CF_ACCESS_CLIENT_ID ?? '';
  const secret = env.CF_ACCESS_CLIENT_SECRET ?? '';
  if (!env.STAGING_URL || (!id && !secret)) return null;
  if (!id || !secret) {
    throw new Error(`Only ${id ? 'CF_ACCESS_CLIENT_ID' : 'CF_ACCESS_CLIENT_SECRET'} is set: the Access service token needs `
      + `both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (${ACCESS_HELP}).`);
  }
  const url = new URL(env.STAGING_URL);
  // The secret never travels in the clear (a loopback test server aside).
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new Error(`STAGING_URL must be https:// to send the Access service token, got ${url.origin}`);
  }
  return { origin: url.origin, headers: { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret } };
}

/** The token's headers for a request to url: only when url is on the staging origin, else null. */
export function accessHeaders(url: string, access: StagingAccess | null = stagingAccess()): Record<string, string> | null {
  return access && new URL(url).origin === access.origin ? access.headers : null;
}

/**
 * Options for an APIRequestContext call to url: the token's headers when url is on the staging origin,
 * following no redirect so they can't be sent on anywhere else; otherwise none.
 */
export function accessRequest(url: string, access: StagingAccess | null = stagingAccess()): { headers?: Record<string, string>; maxRedirects?: number } {
  const headers = accessHeaders(url, access);
  return headers ? { headers, maxRedirects: 0 } : {};
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Why Access refused a response, or null if it didn't: a redirect to its login page, a 401 or a 403. */
export function accessRefusal(status: number, location: string | null, from: string): string | null {
  if (status === 401 || status === 403) return `HTTP ${status}`;
  if (!REDIRECTS.has(status) || !location) return null;
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    return null;
  }
  const login = target.hostname.endsWith('.cloudflareaccess.com') || target.pathname.startsWith('/cdn-cgi/access/');
  return login ? `HTTP ${status} to the Access login at ${target.origin}` : null;
}

/** The message for a refusal: it names the token that is missing or was rejected. */
export function accessMessage(url: string, why: string, access: StagingAccess | null): string {
  return access
    ? `Cloudflare Access rejected the service token in CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET at ${url} (${why}). `
      + `Check the token hasn't expired or been revoked, and that the project's Access app has a Service Auth policy that includes it (${ACCESS_HELP}).`
    : `${url} is behind Cloudflare Access (${why}) and no Access service token is set. Add the repository secrets `
      + `CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET for a token with a Service Auth policy on the project's Access app (${ACCESS_HELP}).`;
}

/**
 * Before the staging checks: one GET of deployment-id.json on the staging address, with the token if
 * set, following no redirect. Fails closed, with a GitHub error annotation, when Access refuses it.
 */
export async function checkStagingAccess(stagingUrl: string, access: StagingAccess | null, get: typeof fetch = fetch): Promise<void> {
  const url = new URL('deployment-id.json', stagingUrl).href;
  const response = await get(url, { headers: accessHeaders(url, access) ?? {}, redirect: 'manual' });
  await response.body?.cancel();
  const why = accessRefusal(response.status, response.headers.get('location'), url);
  if (why) {
    const message = accessMessage(stagingUrl, why, access);
    process.stdout.write(`::error::${message}\n`);
    throw new Error(message);
  }
}
