import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '@playwright/test';
import { monitor } from './support';
import { accessRequest, stagingAccess, type StagingAccess } from './stagingAccess';

/*
 * The Cloudflare Access service token on staging (docs/HOSTING.md#staging), against a stand-in: a
 * staging server that answers every request without the token with a 302 to the Access login, as
 * Access does, and a second origin that records whether the token ever reaches it.
 *
 * In the browser, redirects stay on staging: Chromium stalls a fulfilled 302 to another origin (the
 * guard's fetch-and-fulfill mode, which every request carrying the token takes). Real staging only
 * redirects off its origin to the Access login, which the guard refuses. A redirect off staging is
 * checked on the direct requests below, which follow none.
 */

const ID = 'id.access';
const SECRET = 'not-for-logs';
const LOGIN = 'https://brainrottcg-pages.cloudflareaccess.com/cdn-cgi/access/login/staging.brainrottcg.pages.dev';

let staging: Server;
let other: Server;
let stagingUrl: string;
let otherOrigin: string;
let access: StagingAccess | null;
const stagingHits: { path: string; token: boolean }[] = [];
const otherHits: { path: string; headers: IncomingHttpHeaders }[] = [];

const page = (otherOrigin: string) => `<!doctype html><meta charset="utf-8"><title>Staging behind Access</title>
<output id="out"></output>
<script type="module">
  const text = async (url) => (await fetch(url)).text();
  const result = {
    page: await text('/data.json'),
    redirected: await text('/moved'),
    other: await text('${otherOrigin}/probe'),
  };
  const worker = new Worker('/worker.js', { type: 'module' });
  result.worker = await new Promise((resolve) => { worker.onmessage = (event) => resolve(event.data); });
  document.getElementById('out').textContent = JSON.stringify(result);
</script>`;

const worker = (otherOrigin: string) => `
const text = async (url) => (await fetch(url)).text();
postMessage({ data: await text('/worker-data.json'), other: await text('${otherOrigin}/probe-worker') });`;

test.beforeAll(async () => {
  other = createServer((request, response) => {
    otherHits.push({ path: new URL(request.url ?? '/', 'http://other').pathname, headers: request.headers });
    response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }).end('other');
  });
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  otherOrigin = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;

  staging = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://staging').pathname;
    const token = request.headers['cf-access-client-id'] === ID && request.headers['cf-access-client-secret'] === SECRET;
    stagingHits.push({ path, token });
    if (!token) return void response.writeHead(302, { location: LOGIN }).end();
    const body: Record<string, [string, string]> = {
      '/': ['text/html', page(otherOrigin)],
      '/worker.js': ['text/javascript', worker(otherOrigin)],
      '/data.json': ['application/json', '"page-data"'],
      '/worker-data.json': ['application/json', '"worker-data"'],
    };
    if (path === '/moved') return void response.writeHead(302, { location: '/data.json' }).end();
    if (path === '/away') return void response.writeHead(302, { location: `${otherOrigin}/landing` }).end();
    const [type, content] = body[path] ?? ['text/plain', 'missing'];
    response.writeHead(body[path] ? 200 : 404, { 'content-type': type }).end(content);
  });
  await new Promise<void>((resolve) => staging.listen(0, '127.0.0.1', resolve));
  stagingUrl = `http://127.0.0.1:${(staging.address() as AddressInfo).port}/`;
  access = stagingAccess({ STAGING_URL: stagingUrl, CF_ACCESS_CLIENT_ID: ID, CF_ACCESS_CLIENT_SECRET: SECRET });
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => staging.close(() => resolve()));
  await new Promise<void>((resolve) => other.close(() => resolve()));
});

test.beforeEach(() => {
  stagingHits.length = 0;
  otherHits.length = 0;
});

const leaked = () => otherHits.filter(({ headers }) => Object.keys(headers).some((name) => name.startsWith('cf-access-')));

for (const continueAllowed of [false, true]) {
  test(`the page and its worker sign in to staging, and the token goes nowhere else (continueAllowed: ${continueAllowed})`, async ({ page }) => {
    const errors = await monitor(page, stagingUrl, 0, { access, continueAllowed, localOrigins: { [otherOrigin]: ['/'] } });
    await page.goto(stagingUrl);
    await expect(page.locator('#out')).toHaveText(JSON.stringify({
      page: '"page-data"',
      redirected: '"page-data"',
      other: 'other',
      worker: { data: '"worker-data"', other: 'other' },
    }));

    expect(stagingHits.map(({ path }) => path).sort()).toEqual(['/', '/data.json', '/data.json', '/moved', '/worker-data.json', '/worker.js']);
    expect(stagingHits.filter(({ token }) => !token)).toEqual([]);
    expect(otherHits.map(({ path }) => path).sort()).toEqual(['/probe', '/probe-worker']);
    expect(leaked()).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('without the token, staging answers with the Access login, which the guard keeps the page from', async ({ page }) => {
  const errors = await monitor(page, stagingUrl, 0, { access: null, failOnUnexpected: false });
  const response = await page.goto(stagingUrl);
  expect(response?.status()).toBe(403);
  expect(stagingHits).toEqual([{ path: '/', token: false }]);
  expect(errors.blocked).toEqual([`[blocked redirect escape: ${new URL(LOGIN).origin}${new URL(LOGIN).pathname}] GET ${stagingUrl}`]);
});

test('direct requests send the token to staging only, and follow no redirect with it', async ({ page }) => {
  const data = await page.request.get(`${stagingUrl}data.json`, accessRequest(`${stagingUrl}data.json`, access));
  expect(await data.text()).toBe('"page-data"');
  const away = await page.request.get(`${stagingUrl}away`, accessRequest(`${stagingUrl}away`, access));
  expect(away.status()).toBe(302);
  expect(away.headers()['location']).toBe(`${otherOrigin}/landing`);
  expect(otherHits).toEqual([]);

  const probe = await page.request.get(`${otherOrigin}/probe`, accessRequest(`${otherOrigin}/probe`, access));
  expect(await probe.text()).toBe('other');
  expect(otherHits.map(({ path }) => path)).toEqual(['/probe']);
  expect(leaked()).toEqual([]);
  expect(stagingHits).toEqual([{ path: '/data.json', token: true }, { path: '/away', token: true }]);
});
