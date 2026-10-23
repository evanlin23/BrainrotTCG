import { readdirSync } from 'node:fs';
import { test, expect, type Page, type Locator, type WebSocketRoute } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { cardPoints } from '../../src/engine/scoring';
import { decodeCard } from '../../src/game/cardCode';
import { HOF_RELAYS } from '../../src/game/nostrInbox';
import type { Finish, Rarity } from '../../src/engine/types';
import { accessHeaders, stagingAccess, type StagingAccess } from './stagingAccess';

// On-disk boundary shapes: importing UI Stats pulls TSX/Vite assets into the Node test project.
interface RecordedCard {
  key: string; setId: string; id: string; name: string; rarity: Rarity; image: string;
  isHolo: boolean; finish?: Finish | null; misprint?: boolean;
}
interface CollectionItem {
  card: Pick<RecordedCard, 'key' | 'setId' | 'id' | 'name' | 'rarity' | 'image'>;
  normalCount: number; holoCount: number;
  finishes?: Partial<Record<Finish, number>>; misprints?: number; modifierPoints?: number;
}
interface Stats {
  packsOpened: number; highestPackCards?: RecordedCard[];
  highestPackRef?: { setId: string; setVersion: number; nonce: number; publicKeyHex?: string };
  highestPackHandName?: string; highestPackFlexValue?: number;
}

export interface MonitorOptions {
  routeHttp?: boolean;
  returning?: boolean;
  allowedOrigins?: string[];
  allowedPaths?: string[];
  /**
   * Other local sites the test serves itself (a second app, an old address, a stranger's page),
   * each origin with the only path prefixes it may load. Unlike `allowedOrigins`, these never share
   * `allowedPaths`, and every one must be plain http on a loopback host (127.0.0.1, localhost or
   * [::1]): anything else throws before the page is guarded, so no public origin can be let in.
   */
  localOrigins?: Record<string, string[]>;
  allowedMethods?: string[];
  allowWrites?: boolean;
  /**
   * Which WebSocket attempts are allowed. `false` or omitted: none, every attempt is recorded and
   * closed. `true`: all, left as an unconnected mock (no server is ever contacted). A list: URLs
   * starting with one of its prefixes are allowed, others are recorded. A function: gets the socket
   * (to script fake relay messages) and allows it unless it returns `false` or throws. Allowed
   * sockets are never connected to a server, so nothing reaches the network either way. The
   * product's own Hall of Fame relays are the one exception: closed unconnected and not recorded.
   */
  allowWebSocket?: boolean | string[] | ((socket: WebSocketRoute) => boolean | void);
  /** Fail the running test at teardown when the guard recorded an attempt. Default true. */
  failOnUnexpected?: boolean;
  /**
   * Keep the original same-origin `route.continue()` (after the origin, method and path checks)
   * instead of fetching and fulfilling the response. Cold performance runs need it: fulfilled
   * responses skip CDP network throttling and change byte accounting. Redirects and CSP are then
   * only observed, never enforced. With a staging Access token (`access`) every request is still
   * fetched: a continued request would send the token on to wherever a redirect leads, and Chromium
   * stalls a continued cross-origin request from a page whose document was fulfilled.
   */
  continueAllowed?: boolean;
  /**
   * The Cloudflare Access service token for real staging (stagingAccess.ts): its headers go on every
   * request to its origin, from the page and its workers, and to no other origin. Defaults to the
   * one in the environment, which is null unless STAGING_URL and the token are set.
   */
  access?: StagingAccess | null;
}

export type MonitorErrors = string[] & {
  /** Sanitized unexpected network attempts (at most 40), kept apart from product errors. */
  blocked: string[];
  /**
   * The monitor's HTTP policy for guards that cannot use `page.route` (warm runs, which keep the
   * HTTP cache): null when the request is allowed, otherwise the status and body to answer with.
   * A refusal is recorded like any other unexpected attempt.
   */
  refuse(method: string, url: string): { status: number; body: string } | null;
};

const MAX_BLOCKED_ENTRIES = 40;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
function originOf(urlString: string): string {
  try {
    return new URL(urlString).origin;
  } catch {
    return '';
  }
}
/** The relays the product itself dials; browser fixtures close them unconnected without recording. */
const productRelayOrigins = new Set(HOF_RELAYS.map(originOf));
const CSP_REPORT_PATH = '/__network-guard/csp-report';

function sanitizeUrl(urlString: string): string {
  try {
    const url = new URL(urlString);
    return `${url.origin}${url.pathname}`;
  } catch {
    return 'invalid-url';
  }
}

function sanitizeAttempt(method: string, urlString: string, note?: string): string {
  const sanitized = `${method.toUpperCase()} ${sanitizeUrl(urlString)}`;
  return note ? `[${note}] ${sanitized}` : sanitized;
}

/**
 * Collects page errors, enforces network guard isolation, and seeds a fixture player.
 * `returning` also records saved packs, so the tabs show: a new player sees only the packs screen
 * until their first pack is saved (#222).
 *
 * Network isolation rules:
 * - Only intended local read requests/paths are permitted; writes are refused with 403.
 * - Redirects are inspected with maxRedirects: 0; any redirect escape outside allowed origin/path is refused with 403.
 * - CSP is applied to enforce boundaries inside workers.
 * - Teardown fails on unexpected I/O attempts with bounded sanitized evidence.
 * - routeHttp: false preserves the HTTP cache for warm performance measurements (baseline.spec.ts).
 */
export async function monitor(
  page: Page,
  baseURL: string,
  historyRecords = 0,
  options: MonitorOptions = {},
): Promise<MonitorErrors> {
  const {
    routeHttp = true,
    returning = false,
    allowedOrigins: extraOrigins = [],
    allowedPaths: customPaths,
    localOrigins = {},
    allowedMethods: customMethods,
    allowWrites = false,
    allowWebSocket,
    failOnUnexpected = true,
    continueAllowed = false,
    access = stagingAccess(),
  } = options;

  const errors = [] as unknown as MonitorErrors;
  const blocked: string[] = [];
  Object.defineProperty(errors, 'blocked', {
    value: blocked,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  const noteBlocked = (entry: string) => {
    if (blocked.length < MAX_BLOCKED_ENTRIES && !blocked.includes(entry)) {
      blocked.push(entry);
    }
  };

  const base = new URL(baseURL);
  const origin = base.origin;
  const localPaths = new Map<string, string[]>();
  for (const [local, paths] of Object.entries(localOrigins)) {
    let url: URL | null = null;
    try {
      url = new URL(local);
    } catch {
      // Reported below
    }
    if (!url || url.origin !== local || url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || paths.length === 0) {
      throw new Error(`localOrigins takes http loopback origins with at least one path, got "${local}"`);
    }
    localPaths.set(local, paths);
  }
  const allowedOrigins = new Set<string>([origin, ...extraOrigins, ...localPaths.keys()]);
  const allowedPaths = customPaths ?? [base.pathname];
  const allowedMethods = new Set<string>(
    (customMethods ?? (allowWrites ? ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'] : ['GET', 'HEAD'])).map((m) => m.toUpperCase()),
  );

  const isAllowedPath = (pathname: string, from: string): boolean => {
    return (localPaths.get(from) ?? allowedPaths).some(
      (p) => pathname.startsWith(p) || pathname === p.replace(/\/$/, '') || p === '/',
    );
  };

  const isAllowedUrl = (url: URL): boolean => {
    return allowedOrigins.has(url.origin) && isAllowedPath(url.pathname, url.origin);
  };

  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const text = message.text();
      if (text.includes('Content Security Policy')) {
        const match = text.match(/(?:Connecting to|Refused to load|Refused to send|Refused to frame|Refused to connect).*?'([^']+)'/);
        const target = match ? match[1] : '';
        if (target.startsWith('http://') || target.startsWith('https://') || target.startsWith('ws://') || target.startsWith('wss://')) {
          noteBlocked(sanitizeAttempt('CSP', target, 'csp violation'));
        }
      }
      errors.push(text);
    }
  });
  page.on('response', (response) => {
    if (allowedOrigins.has(new URL(response.url()).origin) && response.status() >= 400) {
      errors.push(`${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (allowedOrigins.has(new URL(request.url()).origin)) {
      errors.push(`${request.failure()?.errorText} ${request.url()}`);
    }
  });

  let failedTeardown = false;
  const checkUnexpectedTeardown = () => {
    if (failedTeardown) return;
    if (failOnUnexpected && blocked.length > 0) {
      failedTeardown = true;
      try {
        const currentTest = test.info();
        if (currentTest) {
          currentTest.status = 'failed';
          currentTest.errors.push({
            message: `Unexpected browser I/O blocked by network guard (${blocked.length} attempt${blocked.length === 1 ? '' : 's'}):\n${blocked.join('\n')}`,
          });
        }
      } catch {
        // test.info() unavailable outside active test runner
      }
    }
  };
  page.on('close', checkUnexpectedTeardown);
  page.context().on('close', checkUnexpectedTeardown);

  // Context-wide guards also cover popups and other pages. A socket the handler never connects to a
  // server stays a local mock, so no WebSocket attempt reaches the network, allowed or not.
  const wsPrefixes = Array.isArray(allowWebSocket) ? allowWebSocket : [];
  await page.context().routeWebSocket('**/*', (socket) => {
    if (productRelayOrigins.has(originOf(socket.url()))) {
      // The product's own Hall of Fame relays: an expected failure, closed unconnected, not an attempt.
      socket.close();
      return;
    }
    let allowed = false;
    if (allowWebSocket === true) allowed = true;
    else if (Array.isArray(allowWebSocket)) allowed = wsPrefixes.some((prefix) => socket.url().startsWith(prefix));
    else if (typeof allowWebSocket === 'function') {
      try {
        allowed = allowWebSocket(socket) !== false;
      } catch {
        allowed = false;
      }
    }
    if (allowed) return;
    noteBlocked(sanitizeAttempt('WS', socket.url(), 'disallowed websocket'));
    socket.close();
  });

  // Page CSP: same origin plus the fixture allowlist only (never a blanket ws: or wss:). WebSocket
  // origins follow the allowed HTTP origins and the allowed prefixes.
  const wsOrigins = [...allowedOrigins].map((o) => o.replace(/^http/, 'ws'));
  const prefixOrigins = wsPrefixes.flatMap((prefix) => {
    try {
      return [new URL(prefix).origin];
    } catch {
      return [];
    }
  });
  const connectOrigins = ["'self'", ...allowedOrigins, ...wsOrigins, ...prefixOrigins].join(' ');
  const imgOrigins = ["'self'", 'data:', 'blob:', ...allowedOrigins].join(' ');
  const csp = [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connectOrigins}`,
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    `img-src ${imgOrigins}`,
    "worker-src 'self' blob:",
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    // Violations inside workers never reach the page console, so the browser reports them here.
    `report-uri ${origin}${CSP_REPORT_PATH}`,
  ].join('; ');

  // A redirect hop that leaves the allowlist is an unexpected attempt. Enforced below when
  // responses are fetched; with continueAllowed the browser follows redirects itself, so the
  // hop is only observed here.
  const REDIRECTS = new Set([301, 302, 303, 307, 308]);
  // As many redirects as Chromium follows for one request.
  const MAX_ACCESS_HOPS = 20;
  const redirectTarget = (from: string, location: string | undefined): URL | null => {
    if (!location) return null;
    try {
      return new URL(location, from);
    } catch {
      return null;
    }
  };
  if (continueAllowed || !routeHttp) {
    const noteRedirect = (method: string, from: string, location: string | undefined) => {
      if (!location) return;
      const target = redirectTarget(from, location);
      if (!target || !isAllowedUrl(target)) {
        noteBlocked(sanitizeAttempt(method, from, `redirect escape: ${target ? sanitizeUrl(target.href) : 'unparseable target'}`));
      }
    };
    page.context().on('response', (response) => {
      if (REDIRECTS.has(response.status())) noteRedirect(response.request().method(), response.url(), response.headers()['location']);
    });
    // Playwright sometimes folds a hop the browser followed itself into the final response (about
    // 1 run in 50: a 200 for the first URL, no 302 and no redirected request), so the listener above
    // misses it. Chromium's own Network events report every hop of the page's requests; the same
    // hop seen both ways is recorded once.
    if (page.context().browser()?.browserType().name() === 'chromium') {
      const cdp = await page.context().newCDPSession(page);
      const methods = new Map<string, string>();
      cdp.on('Network.requestWillBeSent', ({ requestId, request, redirectResponse }) => {
        if (!redirectResponse) methods.set(requestId, request.method);
        else if (REDIRECTS.has(redirectResponse.status)) noteRedirect(methods.get(requestId) ?? request.method, redirectResponse.url, request.url);
      });
      await cdp.send('Network.enable');
      // A CDP session sees one page only, so popups and other pages opened later get their own.
      page.context().on('page', (other) => {
        const watchOther = async () => {
          const otherCdp = await other.context().newCDPSession(other);
          const otherMethods = new Map<string, string>();
          otherCdp.on('Network.requestWillBeSent', ({ requestId, request, redirectResponse }) => {
            if (!redirectResponse) otherMethods.set(requestId, request.method);
            else if (REDIRECTS.has(redirectResponse.status)) noteRedirect(otherMethods.get(requestId) ?? request.method, redirectResponse.url, request.url);
          });
          await otherCdp.send('Network.enable');
        };
        // A page that closes before its session opens has nothing left to watch; the context-wide
        // response listener above still covers its hops.
        watchOther().catch(() => {});
      });
    }
  }

  // One policy for every HTTP guard: origin, then method, then path. Records and returns the refusal.
  const refuse = (method: string, url: URL): { status: number; body: string } | null => {
    let refusal: { status: number; body: string; note: string };
    if (!allowedOrigins.has(url.origin)) refusal = { status: 204, body: '', note: 'blocked cross-origin request' };
    else if (!allowedMethods.has(method)) refusal = { status: 403, body: 'Forbidden write', note: 'disallowed write' };
    else if (!isAllowedPath(url.pathname, url.origin)) refusal = { status: 403, body: 'Forbidden path', note: 'disallowed path' };
    else return null;
    noteBlocked(sanitizeAttempt(method, url.href, refusal.note));
    return refusal;
  };
  Object.defineProperty(errors, 'refuse', {
    value: (method: string, url: string) => refuse(method.toUpperCase(), new URL(url)),
    enumerable: false,
  });

  // Playwright HTTP routing disables the HTTP cache, so warm performance runs guard HTTP themselves.
  if (routeHttp) {
    await page.context().route('**/*', async (route) => {
      const request = route.request();
      const reqUrl = new URL(request.url());
      const method = request.method().toUpperCase();

      if (method === 'POST' && reqUrl.origin === origin && reqUrl.pathname === CSP_REPORT_PATH) {
        // The guard's own CSP violation report: record where the blocked request was headed, nothing else.
        try {
          const report = JSON.parse(request.postData() ?? '{}')['csp-report'] as { 'blocked-uri'?: string } | undefined;
          const target = report?.['blocked-uri'] ?? '';
          if (/^(https?|wss?):/.test(target)) noteBlocked(sanitizeAttempt('CSP', target, 'csp violation'));
        } catch {
          // A malformed report carries no evidence
        }
        return route.fulfill({ status: 204 });
      }

      const refusal = refuse(method, reqUrl);
      if (refusal) {
        return route.fulfill({ status: refusal.status, contentType: 'text/plain', body: refusal.body });
      }

      if (continueAllowed && !access) return route.continue();
      const token = accessHeaders(request.url(), access);

      let response;
      let url = request.url();
      try {
        const headers = token ? { headers: { ...request.headers(), ...token } } : {};
        response = await route.fetch({ maxRedirects: 0, ...headers });
        // The browser sends the hop after a fulfilled redirect itself, past this handler, so on
        // staging it would go without the token: follow staging's redirects to its own origin here.
        // The page then gets the last response at the URL it asked for.
        for (let hop = 0; token && hop < MAX_ACCESS_HOPS && REDIRECTS.has(response.status()); hop++) {
          const target = redirectTarget(url, response.headers()['location']);
          if (!target || target.origin !== access?.origin || !isAllowedUrl(target)) break;
          url = target.href;
          response = await route.fetch({ url, maxRedirects: 0, ...headers });
        }
      } catch {
        return route.abort();
      }

      if (REDIRECTS.has(response.status())) {
        const target = redirectTarget(url, response.headers()['location']);
        if (target && !isAllowedUrl(target)) {
          noteBlocked(sanitizeAttempt(method, url, `blocked redirect escape: ${sanitizeUrl(target.href)}`));
          return route.fulfill({ status: 403, contentType: 'text/plain', body: 'Redirect blocked by network guard' });
        }
      }

      try {
        await route.fulfill({ response, headers: continueAllowed ? response.headers() : { ...response.headers(), 'content-security-policy': csp } });
      } catch {
        // In-flight requests aborted by page navigation or close
      }
    });
  }

  await page.addInitScript(({ historyRecords, returning, keys, origin }) => {
    if (window.location.origin !== origin) return;
    // Fresh smoke seeds identity/audio only; optional performance history below is synthetic.
    if (!localStorage.getItem('brainrot-player-v1')) {
      localStorage.setItem('brainrot-player-v1', JSON.stringify({
        secretKey: '01'.repeat(32), name: 'Browser smoke fixture', nextNonce: historyRecords, createdAt: 1,
      }));
      localStorage.setItem('brainrot-settings-v1', JSON.stringify({ effectsVolume: 0 }));
      if (returning) {
        localStorage.setItem(keys.STATS, JSON.stringify({ packsOpened: Math.max(historyRecords, 1), holoCards: {}, highestPackValue: 0, highestPackCards: [] }));
      }
      if (historyRecords) {
        // Performance shape only: repeated nonce0 cached cards at synthetic nonces. This is
        // intentionally NOT a verified history/profile, and never enters a proof verifier.
        localStorage.setItem(keys.HISTORY, JSON.stringify(Array.from({ length: historyRecords }, (_, n) => ({
          s: 'right-now', v: 2, n, k: '8a88e3dd7409f195', c: 'bukangi,niu-laiG,bukangi,la-peace,verity', h: 'Pair', x: 1020, t: 1,
        }))));
        localStorage.setItem('brainrot-data-version', '3');
      }
    }
  }, { historyRecords, returning, keys: STORAGE_KEYS, origin });
  return errors;
}

/**
 * Holds the ticket worker's jobs until `releaseTickets`, so a torn pack waits on a ticket that's still
 * mining. Call before the page loads.
 */
export async function holdTickets(page: Page) {
  await page.addInitScript(() => {
    const held: (() => void)[] = [];
    let holding = true;
    const native = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<Worker['postMessage']>) {
      const send = () => (native as (...a: unknown[]) => void).apply(this, args);
      if (holding) held.push(send);
      else send();
    } as Worker['postMessage'];
    Object.defineProperty(window, '__releaseTickets', { value: () => { holding = false; held.splice(0).forEach((send) => send()); } });
  });
}

export async function releaseTickets(page: Page) {
  await page.evaluate(() => (window as unknown as { __releaseTickets: () => void }).__releaseTickets());
}

/** Card art counts once CardImage marks it ready, not when its 1px placeholder has loaded. */
export async function expectDecoded(images: Locator, count: number) {
  await expect(images).toHaveCount(count);
  for (const image of await images.all()) {
    await expect.poll(() => image.evaluate((element: HTMLImageElement) =>
      (element.dataset.state ?? 'ready') === 'ready' && element.complete && element.naturalWidth > 0 && element.naturalHeight > 0,
    )).toBe(true);
    await image.evaluate((element: HTMLImageElement) => element.decode());
  }
}

/** The summary ignores clicks on its cards and Share for its first moments (#627); a deliberate click waits for that to end. */
export async function expectSummaryTakesClicks(page: Page) {
  await expect(page.locator('.summary-cards')).toBeVisible();
  await expect(page.locator('.summary-cards[data-settling]')).toHaveCount(0);
}

const sets = new URL('../../src/content/sets/', import.meta.url);
const cardIds = readdirSync(sets, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((set) => readdirSync(new URL(`${set.name}/cards/`, sets)).filter((file) => file.endsWith('.webp')))
  .map((file) => file.slice(0, -'.webp'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
/** A card's built art, plain or as a finish thumbnail; never the pack, its thumbnail or the frame mask. */
const ART = `/assets/(?:${cardIds.join('|')})(?:\\.[a-z]+)?-[\\w-]{8}\\.webp`;
export const artUrl = new RegExp(`${ART}$`);
/** A logged failure that names a card's art (request failures and the errors that carry its URL). */
export const namesArt = new RegExp(ART);

type ArtMode = 'serve' | 'hold' | 'drop';

/**
 * Decides what happens to every card art request, now and later: `serve` it, `hold` it until the mode
 * changes, or `drop` it (a failed load). Switching modes settles the held requests; the rest of the app
 * loads as usual. Call before the page loads.
 */
export async function routeArt(page: Page, start: ArtMode) {
  let mode = start;
  let requests = 0;
  let failed = 0;
  const waiting: (() => void)[] = [];
  await page.route(artUrl, async (route) => {
    requests += 1;
    while (mode === 'hold') await new Promise<void>((resolve) => waiting.push(resolve));
    if (mode === 'drop') {
      failed += 1;
      return route.abort();
    }
    return route.continue();
  });
  return {
    /** Art requests the page has made, held or not. */
    requests: () => requests,
    /** Art requests dropped so far. */
    failed: () => failed,
    set(next: ArtMode) {
      mode = next;
      waiting.splice(0).forEach((wake) => wake());
    },
  };
}

/** Fails every card art request until restored; the rest of the app loads as usual. */
export async function dropArt(page: Page) {
  const art = await routeArt(page, 'drop');
  return { failed: art.failed, restore: () => art.set('serve') };
}

/** Holds every card art request until `set('serve')` or `set('drop')`. */
export const holdArt = (page: Page) => routeArt(page, 'hold');

/** Errors other than the art that was meant to fail. */
export const unexpectedArtErrors = (errors: string[]) =>
  errors.filter((error) => !namesArt.test(error) && error !== 'Failed to load resource: net::ERR_FAILED');

/** Waits until the target's box holds still between two reads, 150ms apart (the pack drops in). */
export async function expectStill(target: Locator, message: string) {
  let last = '';
  await expect.poll(async () => {
    const box = JSON.stringify(await target.boundingBox());
    const still = box === last;
    last = box;
    return still;
  }, { message, intervals: [150] }).toBe(true);
}

export async function snapshot(page: Page) {
  return page.evaluate((keys) => ({
    stats: JSON.parse(localStorage.getItem(keys.STATS) ?? 'null'),
    collection: JSON.parse(localStorage.getItem(keys.COLLECTION) ?? 'null'),
    history: JSON.parse(localStorage.getItem(keys.HISTORY) ?? 'null'),
  }), STORAGE_KEYS) as Promise<{
    stats: Stats;
    collection: Record<string, CollectionItem>;
    history: { s: string; v: number; n: number; k: string; c: string; h: string; x: number; t: number }[];
  }>;
}

export async function expectRecordedPack(page: Page, nonce = 0, historyCount = 1) {
  const before = await snapshot(page);
  expect(before.stats.packsOpened).toBe(1);
  expect(before.stats.highestPackCards).toHaveLength(5);
  const cards = before.stats.highestPackCards!;
  const expectedCollection: Record<string, CollectionItem> = {};
  for (const card of cards) {
    const entry = expectedCollection[card.key] ??= {
      card: { key: card.key, setId: card.setId, id: card.id, name: card.name, rarity: card.rarity, image: card.image },
      normalCount: 0, holoCount: 0,
    };
    if (card.isHolo) entry.holoCount++;
    else entry.normalCount++;
    if (card.finish) {
      entry.finishes ??= {};
      entry.finishes[card.finish] = (entry.finishes[card.finish] ?? 0) + 1;
    }
    if (card.misprint) entry.misprints = (entry.misprints ?? 0) + 1;
    const extra = cardPoints(card.rarity, card.isHolo, card.finish, card.misprint) - cardPoints(card.rarity, card.isHolo);
    if (extra) entry.modifierPoints = (entry.modifierPoints ?? 0) + extra;
  }
  expect(before.collection).toEqual(expectedCollection);
  expect(Object.values(before.collection).reduce((total, entry) => total + entry.normalCount + entry.holoCount, 0)).toBe(5);
  expect(before.history).toHaveLength(historyCount);
  const ref = before.stats.highestPackRef!;
  expect(ref).toMatchObject({ nonce });
  expect(ref.publicKeyHex).toBe('8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c');
  const [history] = before.history;
  expect(history).toMatchObject({
    s: ref.setId, v: ref.setVersion, n: ref.nonce, k: ref.publicKeyHex!.slice(0, 16),
    h: before.stats.highestPackHandName, x: before.stats.highestPackFlexValue,
  });
  expect(history.t).toBeGreaterThan(0);
  expect(history.c.split(',').map(decodeCard)).toEqual(cards.map((card) => ({
    id: card.id, holo: card.isHolo,
    ...(card.finish ? { finish: card.finish } : {}), ...(card.misprint ? { misprint: true } : {}),
  })));
  // Reveals sort by rarity; compare the displayed multiset without changing ticket card order.
  const labels = await page.locator('.summary-card').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')));
  expect(labels.map((label) => cards.find((card) => label?.startsWith(`View ${card.name} up close,`))?.key).sort())
    .toEqual(cards.map((card) => card.key).sort());

  return before;
}

/** One pointer: the mouse, or a single touch point sent over CDP in a touch project. */
export interface Finger {
  press(x: number, y: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  release(): Promise<void>;
}

export async function fingerFor(page: Page, touch: boolean): Promise<Finger> {
  if (!touch) {
    return {
      press: async (x, y) => { await page.mouse.move(x, y); await page.mouse.down(); },
      move: (x, y) => page.mouse.move(x, y),
      release: () => page.mouse.up(),
    };
  }
  const cdp = await page.context().newCDPSession(page);
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points }).then(() => {});
  return {
    press: (x, y) => send('touchStart', [{ x, y }]),
    move: (x, y) => send('touchMove', [{ x, y }]),
    release: () => send('touchEnd', []),
  };
}
