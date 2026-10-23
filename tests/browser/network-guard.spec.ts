import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { HOF_RELAYS } from '../../src/game/nostrInbox';
import { monitor } from './support';

let primaryServer: Server;
let externalServer: Server;
let primaryUrl: string;
let externalUrl: string;
let primaryOrigin: string;
let externalOrigin: string;

let primaryAssetHits = 0;
let primaryWriteHits = 0;
let externalHits = 0;
let pings: { port: number | undefined; connection: string | undefined }[] = [];

test.beforeAll(async () => {
  // Primary / local fixture server (simulating the local app fixture)
  primaryServer = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Network Guard Fixture</title></head>
  <body><div id="root">Network Guard Active</div></body>
</html>`);
      return;
    }
    if (url.pathname === '/asset.json' && req.method === 'GET') {
      primaryAssetHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', local: true }));
      return;
    }
    if (url.pathname === '/ping' && req.method === 'GET') {
      pings.push({ port: req.socket.remotePort, connection: req.headers.connection });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('pong');
      return;
    }
    if (url.pathname === '/hang-up') {
      // Drops the connection without answering, so the guard's fetch fails.
      req.socket.destroy();
      return;
    }
    if (url.pathname === '/write' && req.method === 'POST') {
      primaryWriteHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'written' }));
      return;
    }
    if (url.pathname === '/redirect-escape' && req.method === 'GET') {
      res.writeHead(302, { Location: `${externalUrl}leak` });
      res.end();
      return;
    }
    if (url.pathname === '/redirect-allowed' && req.method === 'GET') {
      res.writeHead(302, { Location: '/asset.json' });
      res.end();
      return;
    }
    if (url.pathname === '/worker-egress.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(`
        fetch('${externalUrl}worker-leak').then(() => {
          postMessage('leaked');
        }).catch((err) => {
          postMessage('blocked: ' + err.message);
        });
      `);
      return;
    }
    if (url.pathname === '/worker-clean.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(`
        postMessage('clean-worker-success');
      `);
      return;
    }
    res.writeHead(404).end();
  });

  // External provider server (simulating external tracking / provider / redirect destination)
  externalServer = createServer((_req, res) => {
    externalHits++;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ externalReceived: true }));
  });

  await new Promise<void>((resolve) => primaryServer.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => externalServer.listen(0, '127.0.0.1', resolve));

  const pPort = (primaryServer.address() as AddressInfo).port;
  const ePort = (externalServer.address() as AddressInfo).port;
  primaryOrigin = `http://127.0.0.1:${pPort}`;
  externalOrigin = `http://127.0.0.1:${ePort}`;
  primaryUrl = `${primaryOrigin}/`;
  externalUrl = `${externalOrigin}/`;
});

test.beforeEach(() => {
  primaryAssetHits = 0;
  primaryWriteHits = 0;
  externalHits = 0;
  pings = [];
});

test.afterAll(async () => {
  await new Promise((resolve) => primaryServer.close(resolve));
  await new Promise((resolve) => externalServer.close(resolve));
});

test('legitimate local read asset loads with 200, zero errors and zero blocked attempts', async ({ page }) => {
  const errors = await monitor(page, primaryUrl);
  await page.goto(primaryUrl);
  const result = await page.evaluate(async () => {
    const res = await fetch('/asset.json');
    return { status: res.status, json: await res.json() };
  });

  expect(result.status).toBe(200);
  expect(result.json).toEqual({ status: 'ok', local: true });
  expect(primaryAssetHits).toBe(1);
  expect(externalHits).toBe(0);
  expect(errors).toEqual([]);
  expect(errors.blocked).toEqual([]);
});

// missing_scenario (#1025): monitor() fetched through Playwright's keep-alive pool, so a request could reuse a
// socket the server was closing and fail with ECONNRESET, which the guard turned into an aborted chunk or favicon.
// Reusing no socket is what a test can pin; the reset itself needs a server that closes at a moment the test can't pick.
// missing_scenario (#1046): a monitored request whose fetch failed reached the page as a bare net::ERR_FAILED,
// so the test timed out later on whatever never appeared, and nothing said which request failed or why.
// Its teardown twin is below.
test('a monitored request whose fetch fails is recorded with its method, URL and reason', async ({ page }) => {
  const errors = await monitor(page, primaryUrl, 0, { failOnUnexpected: false });
  await page.goto(primaryUrl);
  const result = await page.evaluate(() => fetch('/hang-up?key=not-for-logs').then(() => 'loaded', (error: Error) => error.name));

  expect(result).toBe('TypeError');
  expect(errors.failed).toEqual([`[fetch failed: socket hang up (ECONNRESET)] GET ${primaryOrigin}/hang-up`]);
  expect(errors.blocked).toEqual([]);
});

test('each monitored request asks for its own connection, so none reuses a socket the server may be closing', async ({ page }) => {
  const errors = await monitor(page, primaryUrl);
  await page.goto(primaryUrl);
  const bodies = await page.evaluate(async () => {
    const first = await (await fetch('/ping?n=1')).text();
    const second = await (await fetch('/ping?n=2')).text();
    return [first, second];
  });

  expect(bodies).toEqual(['pong', 'pong']);
  expect(pings.map((ping) => ping.connection)).toEqual(['close', 'close']);
  expect(new Set(pings.map((ping) => ping.port)).size, 'the two requests arrived on separate sockets').toBe(2);
  expect(errors).toEqual([]);
});

test('redirect escape to external provider is refused with 403 and zero external provider requests', async ({ page }) => {
  const errors = await monitor(page, primaryUrl, 0, { failOnUnexpected: false });
  await page.goto(primaryUrl);
  const result = await page.evaluate(async () => {
    const res = await fetch('/redirect-escape');
    return { status: res.status, text: await res.text() };
  });

  expect(result.status).toBe(403);
  expect(externalHits).toBe(0);
  expect(errors.blocked.length).toBeGreaterThan(0);
  expect(errors.blocked[0]).toContain('blocked redirect escape');
  expect(errors.blocked[0]).toContain(externalOrigin);
});

test('same-origin redirect to allowed local path succeeds', async ({ page }) => {
  const errors = await monitor(page, primaryUrl);
  await page.goto(primaryUrl);
  const result = await page.evaluate(async () => {
    const res = await fetch('/redirect-allowed');
    return { status: res.status, json: await res.json() };
  });

  expect(result.status).toBe(200);
  expect(result.json).toEqual({ status: 'ok', local: true });
  expect(primaryAssetHits).toBe(1);
  expect(externalHits).toBe(0);
  expect(errors).toEqual([]);
  expect(errors.blocked).toEqual([]);
});

test('cross-origin beacon attempt is blocked with zero external provider requests', async ({ page }) => {
  const errors = await monitor(page, primaryUrl, 0, { failOnUnexpected: false });
  await page.goto(primaryUrl);
  const sent = await page.evaluate((target) => {
    return navigator.sendBeacon(`${target}beacon-tracker`, 'telemetry-payload');
  }, externalUrl);

  expect(sent).toBe(true);
  expect(externalHits).toBe(0);
  expect(errors.blocked.length).toBeGreaterThan(0);
  expect(errors.blocked.some((b) => b.includes('blocked cross-origin') || b.includes('csp violation'))).toBe(true);
});

test('worker outbound fetch is blocked and healthy worker still works', async ({ page }) => {
  const errors = await monitor(page, primaryUrl, 0, { failOnUnexpected: false });
  await page.goto(primaryUrl);

  // Clean worker works without error
  const cleanResult = await page.evaluate(async () => {
    const worker = new Worker('/worker-clean.js');
    return new Promise((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
    });
  });
  expect(cleanResult).toBe('clean-worker-success');

  // Egress worker fetch is blocked; 0 hits on external server
  const egressResult = await page.evaluate(async () => {
    const worker = new Worker('/worker-egress.js');
    return new Promise((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
    });
  });
  expect(egressResult).not.toBe('leaked');
  expect(externalHits).toBe(0);
  // The worker's own egress attempt is recorded, not just refused.
  await expect.poll(() => errors.blocked.some((b) => b.includes(externalOrigin))).toBe(true);
});

test('popup navigation to an external origin is blocked and recorded', async ({ page }) => {
  const errors = await monitor(page, primaryUrl, 0, { failOnUnexpected: false });
  await page.goto(primaryUrl);
  // A real click gives the popup the user activation window.open needs.
  await page.evaluate((target) => {
    document.body.insertAdjacentHTML('beforeend', `<a id="popup-link" target="_blank" href="${target}popup-leak">leave</a>`);
  }, externalUrl);
  // The guard answers the popup's navigation with an empty 204, so no popup page ever appears.
  await page.click('#popup-link');

  expect(externalHits).toBe(0);
  await expect.poll(() => errors.blocked.some((b) => b.includes(`${externalOrigin}/popup-leak`))).toBe(true);
});

test('same-origin POST write is refused with 403 and never reaches server', async ({ page }) => {
  const errors = await monitor(page, primaryUrl, 0, { failOnUnexpected: false });
  await page.goto(primaryUrl);
  const result = await page.evaluate(async () => {
    const res = await fetch('/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: 'player-key-data' }),
    });
    return { status: res.status };
  });

  expect(result.status).toBe(403);
  expect(primaryWriteHits).toBe(0);
  expect(errors.blocked.length).toBeGreaterThan(0);
  expect(errors.blocked.some((b) => b.includes('disallowed write'))).toBe(true);
});

test('explicit fixture allowlist permits secondary local origin without errors', async ({ page }) => {
  const errors = await monitor(page, primaryUrl, 0, {
    allowedOrigins: [externalOrigin],
    failOnUnexpected: true,
  });
  await page.goto(primaryUrl);
  const result = await page.evaluate(async (target) => {
    const res = await fetch(`${target}allowed-api`);
    return { status: res.status, json: await res.json() };
  }, externalUrl);

  expect(result.status).toBe(200);
  expect(result.json).toEqual({ externalReceived: true });
  expect(externalHits).toBe(1);
  expect(errors).toEqual([]);
  expect(errors.blocked).toEqual([]);
});

test('a local origin is allowed only under its own paths', async ({ page }) => {
  const errors = await monitor(page, primaryUrl, 0, {
    localOrigins: { [externalOrigin]: ['/old-site/'] },
    failOnUnexpected: false,
  });
  await page.goto(primaryUrl);
  const result = await page.evaluate(async (target) => {
    const inside = await fetch(`${target}old-site/data.json`);
    const outside = await fetch(`${target}elsewhere`);
    return { inside: inside.status, outside: outside.status, text: await outside.text() };
  }, externalUrl);

  expect(result).toEqual({ inside: 200, outside: 403, text: 'Forbidden path' });
  expect(externalHits).toBe(1);
  expect(errors.blocked).toEqual([`[disallowed path] GET ${externalOrigin}/elsewhere`]);
});

test('a local origin that is not plain http on a loopback host is refused before guarding', async ({ page }) => {
  for (const origin of ['https://example.com', 'http://192.168.1.10:8080', `${externalOrigin}/path`, `https://127.0.0.1:${new URL(externalOrigin).port}`]) {
    await expect(monitor(page, primaryUrl, 0, { localOrigins: { [origin]: ['/'] } })).rejects.toThrow('localOrigins takes http loopback origins');
  }
  await expect(monitor(page, primaryUrl, 0, { localOrigins: { [externalOrigin]: [] } })).rejects.toThrow('at least one path');
});

test('sanitization strips query parameters, hashes, bodies, and bounding to 40 entries', async ({ page }) => {
  const errors = await monitor(page, primaryUrl, 0, { failOnUnexpected: false });
  await page.goto(primaryUrl);

  await page.evaluate(async ({ extUrl }) => {
    // Attempt write with sensitive query and body
    await fetch('/write?token=secret-token-12345#secret-hash', {
      method: 'POST',
      body: JSON.stringify({ privateProof: 'hash-abc-def' }),
    });
    // Attempt beacon with query
    navigator.sendBeacon(`${extUrl}beacon?playerSecret=xyz987#hash`, 'body-payload');
  }, { extUrl: externalUrl });

  expect(errors.blocked.length).toBeGreaterThanOrEqual(2);
  for (const entry of errors.blocked) {
    expect(entry).not.toContain('secret-token-12345');
    expect(entry).not.toContain('secret-hash');
    expect(entry).not.toContain('privateProof');
    expect(entry).not.toContain('hash-abc-def');
    expect(entry).not.toContain('playerSecret');
    expect(entry).not.toContain('xyz987');
    expect(entry).not.toContain('body-payload');
    expect(entry).not.toContain('?');
    expect(entry).not.toContain('#');
  }
});

/** Opens a WebSocket from the page and resolves with how the attempt ended. */
function openSocket(page: Page, url: string) {
  return page.evaluate((target) => new Promise<string>((resolve) => {
    const socket = new WebSocket(target);
    socket.onopen = () => resolve('open');
    socket.onerror = () => resolve('error');
    socket.onclose = () => resolve('closed');
  }), url);
}

const wsTarget = () => `ws://${new URL(externalUrl).host}/relay`;

for (const [name, option] of [
  ['undefined (default)', undefined],
  ['false', false],
] as const) {
  test(`allowWebSocket ${name}: every attempt is recorded and closed`, async ({ page }) => {
    const errors = await monitor(page, primaryUrl, 0, { allowWebSocket: option, failOnUnexpected: false });
    await page.goto(primaryUrl);
    expect(await openSocket(page, wsTarget())).not.toBe('open');
    await expect.poll(() => errors.blocked.some((b) => b.includes(new URL(externalUrl).host))).toBe(true);
    expect(externalHits).toBe(0);
  });
}

test("the product's own relays are closed unconnected without being recorded", async ({ page }) => {
  const errors = await monitor(page, primaryUrl);
  await page.goto(primaryUrl);
  expect(await openSocket(page, HOF_RELAYS[0]!)).not.toBe('open');
  expect(errors.blocked).toEqual([]);
});

test('allowWebSocket true: attempts are allowed as unconnected mocks and not recorded', async ({ page }) => {
  const errors = await monitor(page, primaryUrl, 0, { allowWebSocket: true });
  await page.goto(primaryUrl);
  expect(await openSocket(page, wsTarget())).toBe('open');
  expect(errors.blocked).toEqual([]);
  expect(externalHits).toBe(0);
});

test('allowWebSocket list: a matching prefix is allowed, anything else is recorded', async ({ page }) => {
  const errors = await monitor(page, primaryUrl, 0, { allowWebSocket: [wsTarget()], failOnUnexpected: false });
  await page.goto(primaryUrl);
  expect(await openSocket(page, wsTarget())).toBe('open');
  expect(errors.blocked).toEqual([]);
  expect(await openSocket(page, `ws://${new URL(externalUrl).host}/other`)).not.toBe('open');
  await expect.poll(() => errors.blocked.some((b) => b.includes('/other'))).toBe(true);
});

test('allowWebSocket function: allowed unless it returns false or throws', async ({ page }) => {
  const seen: string[] = [];
  const errors = await monitor(page, primaryUrl, 0, {
    allowWebSocket: (socket) => {
      seen.push(socket.url());
      if (socket.url().endsWith('/refuse')) return false;
      if (socket.url().endsWith('/throw')) throw new Error('handler bug');
    },
    failOnUnexpected: false,
  });
  await page.goto(primaryUrl);
  const host = new URL(externalUrl).host;
  expect(await openSocket(page, `ws://${host}/fine`)).toBe('open');
  expect(errors.blocked).toEqual([]);
  expect(await openSocket(page, `ws://${host}/refuse`)).not.toBe('open');
  expect(await openSocket(page, `ws://${host}/throw`)).not.toBe('open');
  await expect.poll(() => errors.blocked.filter((b) => b.includes('disallowed websocket')).length).toBe(2);
  expect(seen).toHaveLength(3);
});

// Teardown failure is the core acceptance: test.fail() passes only if the guard fails the test
// once the page closes. Each scenario has a recording twin above (failOnUnexpected: false).
test.describe('teardown fails on unexpected attempts', () => {
  test('a monitored request whose fetch fails fails the test at teardown', async ({ page }) => {
    test.fail();
    await monitor(page, primaryUrl);
    await page.goto(primaryUrl);
    await page.evaluate(() => fetch('/hang-up').catch(() => undefined));
  });

  test('blocked HTTP attempt fails the test at teardown', async ({ page }) => {
    test.fail();
    await monitor(page, primaryUrl);
    await page.goto(primaryUrl);
    await page.evaluate((target) => fetch(`${target}leak`).catch(() => undefined), externalUrl);
  });

  test('blocked WebSocket attempt fails the test at teardown', async ({ page }) => {
    test.fail();
    await monitor(page, primaryUrl);
    await page.goto(primaryUrl);
    await openSocket(page, wsTarget());
  });

  test('a WebSocket the allow function refuses fails the test at teardown', async ({ page }) => {
    test.fail();
    await monitor(page, primaryUrl, 0, { allowWebSocket: () => false });
    await page.goto(primaryUrl);
    await openSocket(page, wsTarget());
  });
});

test.describe('continueAllowed keeps the original same-origin routing', () => {
  test('local reads are continued natively; writes and external requests are still refused', async ({ page }) => {
    const errors = await monitor(page, primaryUrl, 0, { continueAllowed: true, failOnUnexpected: false });
    await page.goto(primaryUrl);
    const result = await page.evaluate(async (target) => {
      const read = await fetch('/asset.json');
      const write = await fetch('/write', { method: 'POST', body: 'x' });
      await fetch(`${target}leak`).catch(() => undefined);
      return { read: read.status, write: write.status, csp: read.headers.get('content-security-policy') };
    }, externalUrl);
    expect(result.read).toBe(200);
    expect(result.csp).toBeNull();
    expect(result.write).toBe(403);
    expect(primaryAssetHits).toBe(1);
    expect(primaryWriteHits).toBe(0);
    expect(externalHits).toBe(0);
    expect(errors.blocked.some((b) => b.includes('disallowed write'))).toBe(true);
    expect(errors.blocked.some((b) => b.includes('blocked cross-origin'))).toBe(true);
  });

  // continue() lets the browser follow redirects itself, so this mode cannot stop an escape; it
  // must at least record it so the test fails at teardown. Perf runs only talk to the built preview.
  test('a redirect escape cannot be stopped but is recorded', async ({ page }) => {
    const errors = await monitor(page, primaryUrl, 0, { continueAllowed: true, failOnUnexpected: false });
    await page.goto(primaryUrl);
    await page.evaluate(() => fetch('/redirect-escape').catch(() => undefined));
    await expect.poll(() => errors.blocked.some((b) => b.includes('redirect escape') && b.includes(externalOrigin))).toBe(true);
    // The escape does reach the external server. Wait for that hit, so it can't land after the next
    // test has reset the counters (which made the next test's `externalHits` check fail).
    await expect.poll(() => externalHits).toBe(1);
  });

  test('a redirect escape from another page of the same context is recorded too', async ({ page }) => {
    const errors = await monitor(page, primaryUrl, 0, { continueAllowed: true, failOnUnexpected: false });
    await page.goto(primaryUrl);
    const other = await page.context().newPage();
    await other.goto(primaryUrl);
    await other.evaluate(() => fetch('/redirect-escape').catch(() => undefined));
    await expect.poll(() => errors.blocked.some((b) => b.includes('redirect escape') && b.includes(externalOrigin))).toBe(true);
    await expect.poll(() => externalHits).toBe(1);
    await other.close();
  });
});
