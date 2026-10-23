import { readdirSync } from 'node:fs';
import { test, expect, type Page, type Locator, type Request, type TestInfo, type WebSocketRoute } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { cardPoints } from '../../src/engine/scoring';
import { decodeCard } from '../../src/game/cardCode';
import { HOF_RELAYS } from '../../src/game/nostrInbox';
import { BEACON_URL } from '../../scripts/cloudflare-analytics';
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

/** The fixture player `monitor` seeds: its secret key (01 x32) and the key prefix its history records carry. */
export const PLAYER_SECRET = '01'.repeat(32);
export const PLAYER_KEY_PREFIX = '8a88e3dd7409f195';

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
  /** Fail the running test at teardown when the guard recorded an attempt or a failed fetch. Default true. */
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
   * Sanitized monitored requests whose fetch failed (at most 40): the method, the URL without its
   * query and the reason, for a page that only saw net::ERR_FAILED. A fulfill or abort Playwright
   * refuses is recorded the same way.
   */
  failed: string[];
  /**
   * Requests the guard took on that the page is still waiting for, sanitized and with the guard's
   * stage: "[fetching] METHOD url" while its fetch runs, "[fulfilling] METHOD url" once the answer
   * is handed to the browser and until the browser finishes it. A test that fails names them at
   * teardown, so a wait that ran out says which request it was waiting on.
   */
  readonly pending: string[];
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
/**
 * Stands in for Cloudflare Web Analytics' beacon, which Cloudflare Pages adds to production's pages
 * (scripts/cloudflare-analytics.ts), so checks against the real site are never counted as visits. It
 * does nothing. Its reporting endpoint and every other address at Cloudflare's analytics hosts are
 * refused and recorded like any other origin, so a request to them fails the test at teardown.
 */
export const BEACON_STUB = '/* network guard: inert stand-in for Cloudflare Web Analytics */\n';

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
 * Why a fetch failed: the first line of the error without Playwright's `route.fetch:` prefix, URLs in
 * it sanitized and the given secrets redacted. The call log under that line repeats the full URL and
 * every request header, the Access token included, so none of it is kept.
 */
export function fetchFailureReason(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error);
  let reason = message.split('\n', 1)[0].replace(/^[\w.]+: /, '').replace(/\b(?:https?|wss?):\/\/[^\s'"()]+/g, sanitizeUrl);
  for (const secret of secrets) if (secret) reason = reason.split(secret).join('[redacted]');
  return reason.slice(0, 200) || 'no reason given';
}

/**
 * What the guard's teardown adds to a test's errors: unexpected attempts, monitored requests that
 * failed, and the requests still pending. Pending requests are recorded at close, and a fetch still
 * running then ends only as teardown: a passing test simply didn't need them, so they are named only
 * in a test that is failing anyway, often on a wait for that very request.
 */
export function teardownMessages({ blocked, failed, pending, status }: {
  blocked: readonly string[];
  failed: readonly string[];
  pending: readonly string[];
  status: TestInfo['status'];
}): string[] {
  const messages = [];
  if (blocked.length > 0) {
    messages.push(`Unexpected browser I/O blocked by network guard (${blocked.length} attempt${blocked.length === 1 ? '' : 's'}):\n${blocked.join('\n')}`);
  }
  if (failed.length > 0) {
    messages.push(`Monitored request${failed.length === 1 ? '' : 's'} failed in the network guard (${failed.length}):\n${failed.join('\n')}`);
  }
  if (pending.length > 0 && (messages.length > 0 || status !== 'passed')) {
    messages.push(`Monitored request${pending.length === 1 ? '' : 's'} still waiting when the page closed (${pending.length}):\n${pending.join('\n')}`);
  }
  return messages;
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
 * - Cloudflare Web Analytics' beacon script (a GET of exactly that URL) gets an inert stand-in
 *   (BEACON_STUB). Its reporting endpoint is refused like any other origin; the stand-in never calls it.
 * - Teardown fails on unexpected I/O attempts with bounded sanitized evidence, and on monitored
 *   requests whose fetch failed, named the same way (one failing because the page or context closed
 *   is teardown itself, and isn't recorded).
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
  const failed: string[] = [];
  Object.defineProperty(errors, 'failed', { value: failed, enumerable: false });
  const noteFailed = (entry: string) => {
    if (failed.length < MAX_BLOCKED_ENTRIES && !failed.includes(entry)) failed.push(entry);
  };
  // Added when the guard takes a request on, removed once the browser finishes or fails it, so a request
  // left paused (its fetch still running, or a fulfill the browser never completed) stays named.
  const pending = new Map<Request, string>();
  Object.defineProperty(errors, 'pending', { get: () => [...pending.values()], enumerable: false });
  page.context().on('requestfinished', (request) => pending.delete(request));
  page.context().on('requestfailed', (request) => pending.delete(request));
  /**
   * The request's own page, or the whole context, is closing. Playwright marks a context closing before
   * it disposes the context's request client, which drops every fetch in flight and every fetched
   * response not yet handed over, so a fetch, fulfill or abort refused after this is teardown, not the
   * request failing. The route is context-wide, so another page closing excuses nothing: a refusal on
   * a page that stays open is recorded. A request with no page (a service worker's) is excused only
   * with its context.
   */
  const closing = (request: Request) => {
    if (page.context().isClosed()) return true;
    try {
      return request.frame().page().isClosed();
    } catch {
      return false;
    }
  };
  const secrets = Object.values(access?.headers ?? {});

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
    if (failedTeardown || !failOnUnexpected) return;
    let currentTest;
    try {
      currentTest = test.info();
    } catch {
      return; // test.info() unavailable outside active test runner
    }
    const messages = teardownMessages({ blocked, failed, pending: [...pending.values()], status: currentTest.status });
    if (messages.length > 0) {
      failedTeardown = true;
      if (currentTest.status === 'passed') currentTest.status = 'failed';
      for (const message of messages) currentTest.errors.push({ message });
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
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${BEACON_URL}`,
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
        // A page that closes before its session opens has nothing left to watch. A popup's first
        // navigation hop can also start before its Network.enable resolves; the context-wide
        // response listener above is what still covers that hop.
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

      // Playwright's WebKit routes a blob: load too (Chromium and Firefox keep it in the browser). A blob URL
      // names its creator's origin but its path is a bare id, so the path rule below would refuse the share
      // image the page just drew. It is memory in this page, never a request, so nothing leaves the browser.
      if (reqUrl.protocol === 'blob:') return route.continue();

      if (method === 'POST' && reqUrl.origin === origin && reqUrl.pathname === CSP_REPORT_PATH) {
        // The guard's own CSP violation report: record where the blocked request was headed, nothing else.
        try {
          const report = JSON.parse(request.postData() ?? '{}')['csp-report'] as { 'blocked-uri'?: string } | undefined;
          const target = report?.['blocked-uri'] ?? '';
          if (/^(https?|wss?):/.test(target)) noteBlocked(sanitizeAttempt('CSP', target, 'csp violation'));
        } catch {
          // Something was blocked, even if the report can't say what
          noteBlocked(sanitizeAttempt('CSP', `${origin}${CSP_REPORT_PATH}`, 'malformed csp report'));
        }
        return route.fulfill({ status: 204 });
      }

      if (method === 'GET' && reqUrl.href === BEACON_URL) {
        return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: BEACON_STUB });
      }

      const refusal = refuse(method, reqUrl);
      if (refusal) {
        return route.fulfill({ status: refusal.status, contentType: 'text/plain', body: refusal.body });
      }

      if (continueAllowed && !access) return route.continue();
      const token = accessHeaders(request.url(), access);
      pending.set(request, sanitizeAttempt(method, request.url(), 'fetching'));

      let response;
      let url = request.url();
      /**
       * Answers the request with `answer`, or aborts it. A refusal while the request's page or the context
       * is closing is teardown: the request stays pending, which only a failing test reports. Any other refusal is
       * recorded, since the request it leaves paused holds the page's load with nothing saying why. Once
       * Playwright has refused a fulfill it refuses the abort too, so that request stays pending.
       */
      const end = async (answer?: () => Promise<void>) => {
        if (pending.has(request)) pending.set(request, sanitizeAttempt(method, request.url(), 'fulfilling'));
        const tried = async (step: string, call: () => Promise<void>) => {
          try {
            await call();
            return true;
          } catch (error) {
            if (closing(request)) return true;
            noteFailed(sanitizeAttempt(method, url, `${step} failed: ${fetchFailureReason(error, secrets)}`));
            return false;
          }
        };
        if (answer && await tried('fulfill', answer)) return;
        await tried('abort', () => route.abort());
      };
      try {
        // One connection per request: a kept-alive socket the preview server closes while the machine is
        // busy fails the next request with ECONNRESET, which aborted a chunk or the favicon and failed the test.
        const fetchOptions = { headers: { ...request.headers(), connection: 'close', ...token } };
        response = await route.fetch({ maxRedirects: 0, ...fetchOptions });
        // The browser sends the hop after a fulfilled redirect itself, past this handler, so on
        // staging it would go without the token: follow staging's redirects to its own origin here.
        // The page then gets the last response at the URL it asked for.
        for (let hop = 0; token && hop < MAX_ACCESS_HOPS && REDIRECTS.has(response.status()); hop++) {
          const target = redirectTarget(url, response.headers()['location']);
          if (!target || target.origin !== access?.origin || !isAllowedUrl(target)) break;
          url = target.href;
          response = await route.fetch({ url, maxRedirects: 0, ...fetchOptions });
        }
      } catch (error) {
        // The page only sees net::ERR_FAILED, so name the request and why for teardown (#1046). A fetch
        // cut off because the page or context is closing is teardown itself, and stays pending.
        if (closing(request)) return;
        noteFailed(sanitizeAttempt(method, url, `fetch failed: ${fetchFailureReason(error, secrets)}`));
        return end();
      }

      if (REDIRECTS.has(response.status())) {
        const target = redirectTarget(url, response.headers()['location']);
        if (target && !isAllowedUrl(target)) {
          noteBlocked(sanitizeAttempt(method, url, `blocked redirect escape: ${sanitizeUrl(target.href)}`));
          return end(() => route.fulfill({ status: 403, contentType: 'text/plain', body: 'Redirect blocked by network guard' }));
        }
      }

      // A request the page dropped meanwhile (a navigation, say) fulfills without an error.
      const fetched = response;
      return end(() => route.fulfill({ response: fetched, headers: continueAllowed ? fetched.headers() : { ...fetched.headers(), 'content-security-policy': csp } }));
    });
  }

  await page.addInitScript(({ historyRecords, returning, keys, origin, player }) => {
    if (window.location.origin !== origin) return;
    // Fresh smoke seeds identity/audio only; optional performance history below is synthetic.
    if (!localStorage.getItem('brainrot-player-v1')) {
      localStorage.setItem('brainrot-player-v1', JSON.stringify({
        secretKey: player.secret, name: 'Browser smoke fixture', nextNonce: historyRecords, createdAt: 1,
      }));
      localStorage.setItem('brainrot-settings-v1', JSON.stringify({ effectsVolume: 0 }));
      if (returning) {
        localStorage.setItem(keys.STATS, JSON.stringify({ packsOpened: Math.max(historyRecords, 1), holoCards: {}, highestPackValue: 0, highestPackCards: [] }));
      }
      if (historyRecords) {
        // Performance shape only: repeated nonce0 cached cards at synthetic nonces. This is
        // intentionally NOT a verified history/profile, and never enters a proof verifier.
        localStorage.setItem(keys.HISTORY, JSON.stringify(Array.from({ length: historyRecords }, (_, n) => ({
          s: 'right-now', v: 2, n, k: player.keyPrefix, c: 'bukangi,niu-laiG,bukangi,la-peace,verity', h: 'Pair', x: 1020, t: 1,
        }))));
        localStorage.setItem('brainrot-data-version', '3');
      }
    }
  }, { historyRecords, returning, keys: STORAGE_KEYS, origin, player: { secret: PLAYER_SECRET, keyPrefix: PLAYER_KEY_PREFIX } });
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

/**
 * Resolves once the page has painted a frame and then gone idle. Input events hand React their state
 * synchronously, so whatever a gesture or an event was going to show has been rendered by then: use it
 * to check that nothing followed, in place of a pause.
 */
export function untilIdle(page: Page) {
  return page.evaluate(() => new Promise<void>((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestIdleCallback(() => done())));
  }));
}

/** Scales the root font like a player's text-size setting, and waits for fonts to settle. */
export async function scaleText(page: Page, percent: number) {
  await page.addStyleTag({ content: `html { font-size: ${percent}% !important; }` });
  await page.evaluate(() => document.fonts.ready);
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

/**
 * Waits until the pack stage has finished dropping in. It falls from above the header on a spring and, below 900px,
 * paints and hit-tests over the Settings gear on the way, so a tap in that window lands on the stage instead.
 */
export async function expectPackDropped(page: Page) {
  await expect.poll(() => page.locator('.pack-display').evaluate((el) => {
    const { transform, opacity } = getComputedStyle(el);
    return transform === 'none' && opacity === '1';
  }), { message: 'the pack has finished dropping in' }).toBe(true);
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

type SavedStorage = Record<string, string | null>;

/** Every key in this origin's storage, sorted. Compare it with `sameStorage`, never in a diff: it holds secret keys. */
export const storageOf = (page: Page) => page.evaluate(() => Object.fromEntries(
  Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)]),
)) as Promise<SavedStorage>;

/** Byte-for-byte equality as a boolean, so a failure prints `false` and not the storage (secret keys included). */
export const sameStorage = (a: SavedStorage, b: SavedStorage) => JSON.stringify(a) === JSON.stringify(b);

/** Settings' Back up and Restore rows, and Restore's note and buttons. */
export const settingsOf = (page: Page) => {
  const main = page.getByRole('main', { name: 'Settings', exact: true });
  const row = (label: string) => main.locator('.settings-row').filter({ has: page.locator('.settings-label', { hasText: new RegExp(`^${label}$`) }) });
  const restore = row('Restore');
  return {
    main,
    backUp: row('Back up'),
    restore,
    restoreNote: restore.locator('.settings-desc'),
    importButton: restore.getByRole('button', { name: 'Import', exact: true }),
    keep: restore.getByRole('button', { name: 'Keep mine', exact: true }),
    replace: restore.getByRole('button', { name: 'Replace', exact: true }),
  };
};

/** Picks `file` (a path, or bytes) through the chooser the Import button opens: the real hidden input. */
export async function pickWithImport(page: Page, file: string | { name: string; buffer: Buffer }) {
  const { importButton } = settingsOf(page);
  const chooser = page.waitForEvent('filechooser');
  await importButton.click();
  const picked = await chooser;
  expect(picked.isMultiple()).toBe(false);
  await picked.setFiles(typeof file === 'string' ? file : { ...file, mimeType: 'text/plain' });
}

/**
 * Stand-in relays that answer every read with "nothing stored". `monitor` closes every socket, which the
 * page reads as the live feed being down; this is a relay that works and has nothing, so an empty board
 * is a real one. Nothing leaves the browser. `down`, when given, closes each socket opened while it is true.
 */
export const relaysAnswerEmpty = (page: Page, down: () => boolean = () => false) => page.routeWebSocket(/.*/, (socket) => {
  if (down()) return socket.close();
  socket.onMessage((message) => {
    const [type, subscription] = JSON.parse(String(message)) as [string, string];
    if (type === 'REQ') socket.send(JSON.stringify(['EOSE', subscription]));
  });
});

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

/**
 * With `settled`, a touch's events carry their own timestamps (16 ms apart) and a release comes after
 * a dragged finger has rested 400 ms at its last point. Sent back to back with no time between them, a drag
 * ends as a fling, and the browser swallows the next tap (it only stops the fling), so the tap that
 * follows a drag gets no click.
 */
export async function fingerFor(page: Page, touch: boolean, { settled = false } = {}): Promise<Finger> {
  if (!touch) {
    return {
      press: async (x, y) => { await page.mouse.move(x, y); await page.mouse.down(); },
      move: (x, y) => page.mouse.move(x, y),
      release: () => page.mouse.up(),
    };
  }
  const cdp = await page.context().newCDPSession(page);
  let clock = Date.now() / 1000;
  let last = { x: 0, y: 0 };
  let moved = false;
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number }[], after = 0.016) => {
    clock += after;
    return cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points, ...(settled ? { timestamp: clock } : {}) }).then(() => {});
  };
  return {
    press: (x, y) => { last = { x, y }; moved = false; return send('touchStart', [last]); },
    move: (x, y) => { last = { x, y }; moved = true; return send('touchMove', [last]); },
    release: async () => {
      if (settled && moved) await send('touchMove', [last], 0.4);
      await send('touchEnd', []);
    },
  };
}
