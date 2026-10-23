import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  accessHeaders,
  accessRefusal,
  accessRequest,
  checkStagingAccess,
  stagingAccess,
  type StagingAccess,
} from './browser/stagingAccess';

const ID = 'id.access';
const SECRET = 'not-for-logs';
const STAGING = 'https://staging.brainrottcg.pages.dev/';
const LOGIN = 'https://brainrottcg-pages.cloudflareaccess.com/cdn-cgi/access/login/staging.brainrottcg.pages.dev';

describe('stagingAccess', () => {
  it('is off without STAGING_URL or without both secrets', () => {
    expect(stagingAccess({})).toBeNull();
    expect(stagingAccess({ CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET })).toBeNull();
    expect(stagingAccess({ STAGING_URL: STAGING })).toBeNull();
    // GitHub passes an unset secret as an empty string.
    expect(stagingAccess({ STAGING_URL: STAGING, CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '' })).toBeNull();
  });

  it('scopes the token to the staging origin', () => {
    expect(stagingAccess({ STAGING_URL: STAGING, CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET })).toEqual({
      origin: 'https://staging.brainrottcg.pages.dev',
      headers: { 'CF-Access-Client-Id': ID, 'CF-Access-Client-Secret': SECRET },
    });
  });

  it('names the half of the token that is missing', () => {
    expect(() => stagingAccess({ STAGING_URL: STAGING, CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: '' }))
      .toThrow(/^Only CF_ACCESS_CLIENT_ID is set.*docs\/HOSTING\.md#staging/);
    expect(() => stagingAccess({ STAGING_URL: STAGING, CF_ACCESS_CLIENT_SECRET: SECRET }))
      .toThrow(/^Only CF_ACCESS_CLIENT_SECRET is set/);
  });

  it('never sends the secret in the clear, except to a loopback test server', () => {
    const env = { CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET };
    expect(() => stagingAccess({ ...env, STAGING_URL: 'http://staging.brainrottcg.pages.dev/' })).toThrow(/must be https/);
    expect(stagingAccess({ ...env, STAGING_URL: 'http://127.0.0.1:4173/' })?.origin).toBe('http://127.0.0.1:4173');
  });
});

describe('accessHeaders and accessRequest', () => {
  const access = stagingAccess({ STAGING_URL: STAGING, CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET });

  it('add the token only on the staging origin, following no redirect', () => {
    expect(accessHeaders('https://staging.brainrottcg.pages.dev/assets/worker.js', access)).toEqual(access?.headers);
    expect(accessRequest('https://staging.brainrottcg.pages.dev/sets/index.json', access)).toEqual({ headers: access?.headers, maxRedirects: 0 });
    for (const url of [
      'https://brainrottcg.pages.dev/',
      'https://abc123.brainrottcg.pages.dev/',
      'http://staging.brainrottcg.pages.dev/',
      'https://staging.brainrottcg.pages.dev.example.com/',
      'https://evanlin23.github.io/BrainrotTCG/',
      'https://api.github.com/repos/evanlin23/BrainrotTCG/issues',
      'wss://relay.damus.io/',
    ]) {
      expect(accessHeaders(url, access), url).toBeNull();
      expect(accessRequest(url, access), url).toEqual({});
    }
  });

  it('add nothing without a token', () => {
    expect(accessHeaders(STAGING, null)).toBeNull();
    expect(accessRequest(STAGING, null)).toEqual({});
  });
});

describe('accessRefusal', () => {
  it('reads a login redirect, a 401 or a 403 as Access refusing', () => {
    expect(accessRefusal(302, LOGIN, STAGING)).toBe('HTTP 302 to the Access login at https://brainrottcg-pages.cloudflareaccess.com');
    expect(accessRefusal(302, '/cdn-cgi/access/login', STAGING)).toBe('HTTP 302 to the Access login at https://staging.brainrottcg.pages.dev');
    expect(accessRefusal(401, null, STAGING)).toBe('HTTP 401');
    expect(accessRefusal(403, null, STAGING)).toBe('HTTP 403');
  });

  it('leaves other answers to the checks themselves', () => {
    expect(accessRefusal(200, null, STAGING)).toBeNull();
    expect(accessRefusal(404, null, STAGING)).toBeNull();
    expect(accessRefusal(308, '/index.html', STAGING)).toBeNull();
    expect(accessRefusal(302, 'http://[bad', STAGING)).toBeNull();
  });
});

// A stand-in for staging behind Access: a 302 to the login page without the token, a 403 with the
// wrong one, and deployment-id.json with it.
describe('checkStagingAccess', () => {
  let server: Server;
  let base: string;
  const seen: IncomingMessage['headers'][] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      seen.push(request.headers);
      const id = request.headers['cf-access-client-id'];
      const secret = request.headers['cf-access-client-secret'];
      if (!id && !secret) response.writeHead(302, { location: LOGIN }).end();
      else if (id !== ID || secret !== SECRET) response.writeHead(403).end('Forbidden');
      else if (request.url === '/deployment-id.json') response.writeHead(200, { 'content-type': 'application/json' }).end('{"run":"1-1"}');
      else response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  afterEach(() => {
    seen.length = 0;
    vi.restoreAllMocks();
  });

  const token = (secret = SECRET): StagingAccess | null =>
    stagingAccess({ STAGING_URL: base, CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: secret });
  const annotations = () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    return () => write.mock.calls.map(([text]) => String(text)).join('');
  };

  it('passes with the token, sending it to staging', async () => {
    const output = annotations();
    await checkStagingAccess(base, token());
    expect(output()).toBe('');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ 'cf-access-client-id': ID, 'cf-access-client-secret': SECRET });
  });

  it('fails closed naming the missing token on a login redirect', async () => {
    const output = annotations();
    const check = checkStagingAccess(base, null);
    await expect(check).rejects.toThrow(/is behind Cloudflare Access \(HTTP 302 to the Access login at https:\/\/brainrottcg-pages\.cloudflareaccess\.com\) and no Access service token is set/);
    await expect(check).rejects.toThrow(/CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.*docs\/HOSTING\.md#staging/);
    expect(output()).toMatch(/^::error::.*no Access service token is set.*docs\/HOSTING\.md#staging\)\.\n$/);
    expect(seen[0]).not.toHaveProperty('cf-access-client-id');
  });

  it('fails closed naming the rejected token on a 403, without printing the secret', async () => {
    const output = annotations();
    const check = checkStagingAccess(base, token('wrong-secret'));
    await expect(check).rejects.toThrow(/Cloudflare Access rejected the service token in CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET .*\(HTTP 403\)/);
    expect(output()).toMatch(/^::error::Cloudflare Access rejected the service token.*docs\/HOSTING\.md#staging\)\.\n$/);
    expect(output()).not.toContain('wrong-secret');
    expect(output()).not.toContain(ID);
  });

  it('sends the token nowhere when staging is on another origin', async () => {
    const get = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 200 }));
    await checkStagingAccess('https://staging.brainrottcg.pages.dev/', token(), get);
    expect(get).toHaveBeenCalledWith('https://staging.brainrottcg.pages.dev/deployment-id.json', { headers: {}, redirect: 'manual' });
  });
});

describe('playwright.staging.config.ts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  const load = async (env: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    return (await import('../playwright.staging.config')).default;
  };

  it('on real staging with the token: checks Access first, blocks service workers and records no traces', async () => {
    const config = await load({ STAGING_URL: STAGING, CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET });
    expect(config.globalSetup).toBe('./tests/browser/staging-access.setup.ts');
    expect(config.use).toMatchObject({ baseURL: STAGING, serviceWorkers: 'block', trace: 'off' });
    expect(config.use).not.toHaveProperty('extraHTTPHeaders');
  });

  it('without the token, keeps traces; without STAGING_URL, runs the local stand-in as before', async () => {
    expect((await load({ STAGING_URL: STAGING, CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '' })).use)
      .toMatchObject({ trace: 'retain-on-failure', serviceWorkers: 'block' });
    vi.resetModules();
    vi.unstubAllEnvs();
    const local = await load({ STAGING_URL: undefined, CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET });
    expect(local.globalSetup).toBeUndefined();
    expect(local.use).toMatchObject({ baseURL: 'http://staging.localhost:4176/', trace: 'retain-on-failure' });
  });
});
