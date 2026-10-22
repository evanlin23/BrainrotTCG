/**
 * In-memory stand-ins for everything the Hall of Fame script (scripts/hall-of-fame.ts) talks to: the
 * GitHub REST API (issues, comments, labels), the deployed hall-of-fame.json, and the Nostr relays.
 * `offlineNetwork()` replaces the global `fetch` and `WebSocket` so the real `inbox` and `build` run
 * against them, and anything else (another host, an unknown relay) is refused and recorded, so a test
 * that would reach the network fails instead. No tokens, no network, no live writes.
 */
import type { Filter, NostrEvent } from '../../../src/game/nostrInbox.ts';

export const BOT = 'github-actions[bot]';

export interface FakeIssue {
  number: number;
  title: string;
  body: string | null;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
  labels: { name: string }[];
  state?: string;
  pull_request?: unknown;
}

export interface FakeComment {
  body: string | null;
  created_at: string;
  user: { login: string } | null;
}

export interface GitHubRequest {
  method: string;
  path: string;
  query?: string;
  body?: Record<string, unknown>;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * GitHub's REST API for one repository, as far as the script uses it: listing issues (every label must
 * match, `since` keeps issues updated at or after it, results in pages), opening an issue, reading and
 * adding comments, adding labels and closing. New issues and comments are stamped by the (possibly
 * frozen) clock and opened by the Actions bot, as GitHub does for the workflow token.
 */
export class FakeGitHub {
  readonly requests: GitHubRequest[] = [];
  /** Requests answered with a 500 (set or change it between runs to interrupt one). */
  fail: (request: GitHubRequest) => boolean = () => false;
  private next: number;

  constructor(
    readonly issues: FakeIssue[] = [],
    readonly comments: Record<number, FakeComment[]> = {},
    /** The deployed hall-of-fame.json, or undefined for a 404. */
    public published?: unknown[],
  ) {
    this.next = Math.max(99, ...issues.map((i) => i.number)) + 1;
  }

  /** Non-GET requests, as `METHOD path`. */
  writes(): string[] {
    return this.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
  }

  /** Issues the bot opened (the inbox's filings). */
  botIssues(): FakeIssue[] {
    return this.issues.filter((i) => i.user?.login === BOT);
  }

  /** The answer to a request for this fake, or null if the URL isn't GitHub's. */
  handle(url: string, init: RequestInit = {}): Response | null {
    const method = init.method ?? 'GET';
    if (/^https:\/\/[^/]+\.github\.io\/[^/]+\/hall-of-fame\.json$/.test(url)) {
      return this.published ? json(this.published) : json({ message: 'Not Found' }, 404);
    }
    const match = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+(\/[^?]*)(?:\?(.*))?$/.exec(url);
    if (!match) return null;
    const [, route, query = ''] = match;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const request: GitHubRequest = { method, path: route, ...(query ? { query } : {}), ...(body ? { body } : {}) };
    this.requests.push(request);
    if (this.fail(request)) return json({ message: 'Server Error' }, 500);
    const params = new URLSearchParams(query);
    const now = new Date().toISOString();

    if (route === '/issues' && method === 'GET') {
      const labels = (params.get('labels') ?? '').split(',').filter(Boolean);
      const since = params.get('since');
      const perPage = Number(params.get('per_page') ?? 30);
      const page = Number(params.get('page') ?? 1);
      const matching = this.issues.filter((i) => labels.every((l) => i.labels.some((x) => x.name === l)) && (!since || Date.parse(i.updated_at) >= Date.parse(since)));
      return json(matching.slice((page - 1) * perPage, page * perPage));
    }
    if (route === '/issues' && method === 'POST') {
      const created: FakeIssue = {
        number: this.next++,
        title: String(body!.title),
        body: String(body!.body),
        created_at: now,
        updated_at: now,
        user: { login: BOT },
        labels: ((body!.labels as string[] | undefined) ?? []).map((name) => ({ name })),
        state: 'open',
      };
      this.issues.push(created);
      return json(created, 201);
    }
    const sub = /^\/issues\/(\d+)(\/comments|\/labels)?$/.exec(route);
    const target = sub ? this.issues.find((i) => i.number === Number(sub[1])) : undefined;
    if (!sub || !target) return null;
    const touch = () => (target.updated_at = now);
    if (sub[2] === '/comments' && method === 'GET') {
      const all = this.comments[target.number] ?? [];
      const perPage = Number(params.get('per_page') ?? 30);
      const page = Number(params.get('page') ?? 1);
      return json(all.slice((page - 1) * perPage, page * perPage));
    }
    if (sub[2] === '/comments' && method === 'POST') {
      const added: FakeComment = { body: String(body!.body), created_at: now, user: { login: BOT } };
      (this.comments[target.number] ??= []).push(added);
      touch();
      return json(added, 201);
    }
    if (sub[2] === '/labels' && method === 'POST') {
      for (const name of body!.labels as string[]) if (!target.labels.some((l) => l.name === name)) target.labels.push({ name });
      touch();
      return json(target.labels);
    }
    if (!sub[2] && method === 'PATCH') {
      target.state = String(body!.state);
      touch();
      return json(target);
    }
    return null;
  }
}

/** What one fake relay holds and how it behaves. */
export interface RelayFixture {
  /** Stored events, served as a relay does: matching the filter, newest first, at most `limit`. */
  events?: NostrEvent[];
  /** Raw frames sent before the stored events on the first request (a relay that ignores the filter, or sends junk). */
  junk?: (sub: string) => string[];
  /** Ends every request with CLOSED and this reason instead of serving it. */
  closedWith?: string;
  /** The connection fails. */
  down?: boolean;
}

const matches = (e: NostrEvent, f: Filter) =>
  f.kinds.includes(e.kind) &&
  (!f.ids || f.ids.includes(e.id)) &&
  (!f['#t'] || e.tags.some((t) => t[0] === 't' && f['#t']!.includes(t[1]))) &&
  (f.since === undefined || e.created_at >= f.since) &&
  (f.until === undefined || e.created_at <= f.until);

interface FakeSocket {
  readyState: number;
  send: (raw: string) => void;
  close: () => void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
}

/** Nostr relays (NIP-01 REQ, EVENT, EOSE, CLOSED, CLOSE) by URL. Every REQ is recorded with its filter. */
export class FakeRelays {
  readonly requests: { relay: string; filter: Filter }[] = [];

  constructor(readonly relays: Record<string, RelayFixture>) {}

  connect(url: string): FakeSocket | null {
    const fixture = this.relays[url];
    if (!fixture) return null;
    let first = true;
    const socket: FakeSocket = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      close: () => {
        socket.readyState = 3;
      },
      send: (raw) => {
        const msg = JSON.parse(raw) as unknown[];
        if (msg[0] !== 'REQ') return; // CLOSE needs no answer
        const sub = String(msg[1]);
        const filter = msg[2] as Filter;
        this.requests.push({ relay: url, filter });
        const reply = (frame: string) => queueMicrotask(() => socket.onmessage?.({ data: frame }));
        if (first) for (const frame of fixture.junk?.(sub) ?? []) reply(frame);
        first = false;
        if (fixture.closedWith !== undefined) return reply(JSON.stringify(['CLOSED', sub, fixture.closedWith]));
        const page = (fixture.events ?? [])
          .filter((e) => matches(e, filter))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, filter.limit ?? Infinity);
        for (const e of page) reply(JSON.stringify(['EVENT', sub, e]));
        reply(JSON.stringify(['EOSE', sub]));
      },
    };
    queueMicrotask(() => {
      if (fixture.down) {
        socket.readyState = 3;
        socket.onerror?.({});
        return;
      }
      socket.readyState = 1;
      socket.onopen?.({});
    });
    return socket;
  }
}

