import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '@playwright/test';
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
  expect(errors.unexpectedAttempts).toBeDefined();
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
