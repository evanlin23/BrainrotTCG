// The Hall of Fame workflows' script (verify-issue, inbox, build) run against fixtures: GitHub's
// API, the deployed list and the Nostr relays are all faked, and files go to a temporary folder.
// Nothing here reaches the network or writes public/hall-of-fame.json.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vectors from '../spec/vectors.json';
import { getSet } from '../src/content/sets/index.ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { dailyPulls, decodeProof, encodeProof, HALL_OF_FAME_DAILY_TOP, HALL_OF_FAME_TOP, hallOfFameList, pullId, signProof, topPulls, utf8, verifyProof, type RankableEntry } from '../src/engine/index.ts';
import { fetchEvents, hallOfFameEvent } from '../src/game/nostrInbox.ts';
import { build, inbox, ISSUE_PAGES, listToPublish, verifyIssue } from './hall-of-fame.ts';
import { parseInboxSummary } from './ops-health.ts';

vi.mock('../src/game/nostrInbox.ts', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), fetchEvents: vi.fn() }));

const BOT = 'github-actions[bot]';
const byNote = (note: string) => vectors.valid.find((v) => v.note === note)!.proof;
const fourOfAKind = byNote('mined 4 of a Kind'); // qualifies
const pair = byNote('simple'); // real, doesn't qualify
/** The same 4 of a Kind, signed again with the vectors' key under a display name that isn't allowed. */
const blockedName = (() => {
  const { setId, setVersion, publicKey, nonce } = decodeProof(fourOfAKind);
  return encodeProof(signProof({ setId, setVersion, publicKey, nonce, name: 'xXfuckXx' }, sha256(utf8('brainrot-tcg/vector-key/1'))));
})();
const forged = fourOfAKind.slice(0, -4) + (fourOfAKind.endsWith('AAAA') ? 'BBBB' : 'AAAA');
const idOf = (proof: string) => pullId(decodeProof(proof));
const marker = (proof: string) => `<!-- hof-verified ${idOf(proof)} -->`;
const link = (proof: string) => `https://evanlin23.github.io/BrainrotTCG/#/pull/${proof}`;
/** Freezes the clock (only `Date`) at `time`; the shared afterEach restores it. */
const clockAt = (time: string) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(time));
};
/**
 * A published list the 4 of a Kind (15,000 in lockdown-lore) can only join through `day`'s top: the
 * top 100 sits far above it (an older list's world first doesn't help), and `day` already has `todays` pulls above it.
 */
const dailyOnlyBoard = (day: string, todays: number): RankableEntry[] => [
  ...Array.from({ length: HALL_OF_FAME_TOP }, (_, i) => ({ id: `top-${i}`, setId: 'other-set', hand: 'Full House', multiplier: 150, score: 100_000 + i, submittedAt: '2026-10-01T00:00:00.000Z' })),
  { id: 'first', setId: 'lockdown-lore', hand: '4 of a Kind', multiplier: 250, score: 15_000, submittedAt: '2026-09-01T00:00:00.000Z' },
  ...Array.from({ length: todays }, (_, i) => ({ id: `today-${i}`, setId: 'other-set', hand: 'Full House', multiplier: 150, score: 20_000 + i, submittedAt: `${day}T01:00:00.000Z` })),
];

interface Issue {
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
interface Comment {
  body: string;
  created_at: string;
  user: { login: string };
}
interface Request {
  method: string;
  path: string;
  query?: string;
  body?: Record<string, unknown>;
}
interface Fixture {
  issues: Issue[];
  comments?: Record<number, Comment[]>;
  /** The deployed hall-of-fame.json, or undefined for a 404. */
  published?: unknown[];
  /** Requests GitHub answers with a 500. */
  fail?: (request: Request) => boolean;
}

const issue = (number: number, proof: string | null, { labels = ['hall-of-fame', 'verified'], login = 'alice', updated = '2026-10-01T00:00:00Z', pr = false } = {}): Issue => ({
  number,
  title: '[Hall of Fame] 4 of a Kind',
  body: proof ? `My pull: ${link(proof)}` : 'no link here',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: updated,
  user: { login },
  labels: labels.map((name) => ({ name })),
  ...(pr ? { pull_request: {} } : {}),
});
const comment = (login: string, body: string, at: string): Comment => ({ body, created_at: at, user: { login } });

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

/** GitHub's REST API and the deployed list, served from the fixture. Any other request fails the test. */
const fakeGitHub = (fixture: Fixture) => {
  const comments = fixture.comments ?? {};
  const requests: Request[] = [];
  let next = 100;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      if (/^https:\/\/[^/]+\.github\.io\/[^/]+\/hall-of-fame\.json$/.test(url)) {
        return fixture.published ? json(fixture.published) : json({ message: 'Not Found' }, 404);
      }
      const match = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+(\/[^?]*)(?:\?(.*))?$/.exec(url);
      if (!match) return unexpected(`${method} ${url}`);
      const [, route, query = ''] = match;
      const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      const request: Request = { method, path: route, ...(query ? { query } : {}), ...(body ? { body } : {}) };
      requests.push(request);
      if (fixture.fail?.(request)) return json({ message: 'Server Error' }, 500);
      const params = new URLSearchParams(query);
      const firstPage = (params.get('page') ?? '1') === '1';
      const byNumber = (n: string) => fixture.issues.find((i) => i.number === Number(n));

      if (route === '/issues' && method === 'GET') {
        // As GitHub does: every label must match, `since` keeps issues updated at or after it, and
        // the results come in pages.
        const labels = (params.get('labels') ?? '').split(',').filter(Boolean);
        const since = params.get('since');
        const perPage = Number(params.get('per_page') ?? 30);
        const page = Number(params.get('page') ?? 1);
        const matching = fixture.issues.filter((i) => labels.every((l) => i.labels.some((x) => x.name === l)) && (!since || Date.parse(i.updated_at) >= Date.parse(since)));
        return json(matching.slice((page - 1) * perPage, page * perPage));
      }
      if (route === '/issues' && method === 'POST') {
        const created: Issue = {
          number: next++,
          title: String(body!.title),
          body: String(body!.body),
          // Stamped by the (fake) clock, as GitHub stamps a new issue.
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          user: { login: BOT },
          labels: (body!.labels as string[]).map((name) => ({ name })),
          state: 'open',
        };
        fixture.issues.push(created);
        return json(created, 201);
      }
      const sub = /^\/issues\/(\d+)(\/comments|\/labels)?$/.exec(route);
      if (sub && sub[2] === '/comments' && method === 'GET') return json(firstPage ? (comments[Number(sub[1])] ?? []) : []);
      if (sub && sub[2] === '/comments' && method === 'POST') {
        const added = comment(BOT, String(body!.body), new Date().toISOString());
        (comments[Number(sub[1])] ??= []).push(added);
        return json(added, 201);
      }
      const target = sub && byNumber(sub[1]);
      if (target && sub[2] === '/labels' && method === 'POST') {
        for (const name of body!.labels as string[]) if (!target.labels.some((l) => l.name === name)) target.labels.push({ name });
        return json(target.labels);
      }
      if (target && !sub[2] && method === 'PATCH') return json(Object.assign(target, { state: body!.state }));
      return unexpected(`${method} ${url}`);
    }),
  );
  return { requests, comments, writes: () => requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`) };
};

let unexpectedRequests: string[] = [];
const unexpected = (request: string) => {
  unexpectedRequests.push(request);
  throw new Error(`unexpected request: ${request}`);
};

/** What the run appended to $GITHUB_OUTPUT (the last value of each key). */
const outputs = (): Record<string, string> =>
  existsSync('github-output') ? Object.fromEntries(readFileSync('github-output', 'utf8').trim().split('\n').map((line) => line.split('=') as [string, string])) : {};

let home: string;
let dir: string;
const output = () => path.join(dir, 'hall-of-fame.json');
const entries = () => JSON.parse(readFileSync(output(), 'utf8')) as { issue: number; githubUser: string; submittedAt: string }[];
beforeEach(() => {
  home = process.cwd();
  dir = mkdtempSync(path.join(os.tmpdir(), 'hall-of-fame-'));
  // The script keeps its caches and comment in the working folder, as on a runner.
  process.chdir(dir);
  unexpectedRequests = [];
  vi.stubEnv('GITHUB_TOKEN', 'test-token');
  vi.stubEnv('GITHUB_OUTPUT', path.join(dir, 'github-output'));
  vi.stubEnv('GITHUB_EVENT_PATH', path.join(dir, 'event.json'));
  vi.stubEnv('SITE_URL', undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  process.chdir(home);
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(unexpectedRequests).toEqual([]);
});

describe('build (deploy workflow)', () => {
  it('keeps the existing list without a token, or starts an empty one', async () => {
    vi.stubEnv('GITHUB_TOKEN', undefined);
    const gh = fakeGitHub({ issues: [issue(1, fourOfAKind)] });
    await build(output());
    expect(readFileSync(output(), 'utf8')).toBe('[]\n');
    writeFileSync(output(), '[{"kept":true}]\n');
    await build(output());
    expect(readFileSync(output(), 'utf8')).toBe('[{"kept":true}]\n');
    expect(gh.requests).toEqual([]);
  });

  it('keeps the existing list when GitHub is down', async () => {
    const gh = fakeGitHub({ issues: [issue(1, fourOfAKind)], fail: () => true });
    writeFileSync(output(), '[{"kept":true}]\n');
    await build(output());
    expect(readFileSync(output(), 'utf8')).toBe('[{"kept":true}]\n');
    expect(gh.writes()).toEqual([]);
  });

  it('lists pulls the bot verified, credited from its first marker comment, and never writes to GitHub', async () => {
    const early = '2026-09-01T00:00:00Z';
    const gh = fakeGitHub({
      issues: [
        issue(1, fourOfAKind),
        issue(2, pair), // real, but doesn't qualify
        issue(3, fourOfAKind, { labels: ['hall-of-fame', 'verified', 'rejected'] }), // turned down by a maintainer
        issue(4, fourOfAKind, { pr: true }), // a pull request, not an issue
        issue(5, fourOfAKind, { login: 'mallory' }), // the marker was pasted by a person, not the bot
      ],
      comments: {
        1: [comment('alice', 'look at this', '2026-10-01T00:00:00Z'), comment(BOT, marker(fourOfAKind), '2026-10-02T00:00:00Z'), comment(BOT, marker(fourOfAKind), '2026-10-05T00:00:00Z')],
        // Each would take the credit (an earlier verification) if it counted.
        3: [comment(BOT, marker(fourOfAKind), early)],
        4: [comment(BOT, marker(fourOfAKind), early)],
        5: [comment('mallory', marker(fourOfAKind), early)],
      },
    });
    await build(output());
    expect(entries().map((e) => [e.issue, e.githubUser, e.submittedAt])).toEqual([[1, 'alice', '2026-10-02T00:00:00Z']]);
    expect(entries()[0]).toMatchObject({ id: idOf(fourOfAKind), proof: fourOfAKind, setId: 'lockdown-lore', hand: '4 of a Kind', score: 15000 });
    expect(gh.requests.map((r) => r.path)).not.toContain('/issues/3/comments');
    expect(gh.requests.map((r) => r.path)).not.toContain('/issues/4/comments');
    expect(gh.writes()).toEqual([]);
  });

  it("leaves out a verified pull whose display name isn't allowed", async () => {
    const gh = fakeGitHub({ issues: [issue(1, blockedName)], comments: { 1: [comment(BOT, marker(blockedName), '2026-10-02T00:00:00Z')] } });
    await build(output());
    expect(entries()).toEqual([]);
    expect(gh.writes()).toEqual([]);
  });

  it('reuses the result for an issue unchanged since the last deploy, and checks an edited one again', async () => {
    const fixture: Fixture = { issues: [issue(1, fourOfAKind)], comments: { 1: [comment(BOT, marker(fourOfAKind), '2026-10-02T00:00:00Z')] } };
    const gh = fakeGitHub(fixture);
    await build(output());
    expect(entries().map((e) => e.issue)).toEqual([1]);
    expect(existsSync('hof-build-cache.json')).toBe(true);

    gh.requests.length = 0;
    await build(output());
    expect(entries().map((e) => e.issue)).toEqual([1]);
    expect(gh.requests.map((r) => r.path)).toEqual(['/issues', '/issues']); // `verified` and `daily` listed, nothing re-checked

    // An edit swapped the pull for one that doesn't qualify.
    fixture.issues[0] = issue(1, pair, { updated: '2026-10-03T00:00:00Z' });
    await build(output());
    expect(entries()).toEqual([]);
  });

  it('lists `daily` issues changed since the day before, and counts each only on the day it was verified', async () => {
    const daily = { labels: ['hall-of-fame', 'daily'] };
    const gh = fakeGitHub({
      issues: [
        issue(2, fourOfAKind, { ...daily, updated: '2026-10-16T09:00:00Z' }), // verified today
        issue(3, fourOfAKind, { ...daily, updated: '2026-10-16T08:00:00Z' }), // verified on the 10th, commented on today
        issue(4, fourOfAKind, { ...daily, updated: '2026-10-14T23:59:59Z' }), // unchanged since the 14th
      ],
      comments: {
        2: [comment(BOT, marker(fourOfAKind), '2026-10-16T09:00:00Z')],
        // Each would take the credit (an earlier verification of the same pull) if it counted.
        3: [comment(BOT, marker(fourOfAKind), '2026-10-10T00:00:00Z'), comment('alice', 'still mine', '2026-10-16T08:00:00Z')],
        4: [comment(BOT, marker(fourOfAKind), '2026-10-14T00:00:00Z')],
      },
    });
    clockAt('2026-10-16T12:00:00Z');
    await build(output());
    expect(entries().map((e) => [e.issue, e.submittedAt])).toEqual([[2, '2026-10-16T09:00:00Z']]);
    const listings = gh.requests.filter((r) => r.path === '/issues').map((r) => r.query);
    expect(listings).toEqual(['state=all&labels=hall-of-fame,verified&per_page=100&page=1', 'state=all&labels=hall-of-fame,daily&since=2026-10-15T00:00:00Z&per_page=100&page=1']);
    expect(gh.requests.map((r) => r.path)).not.toContain('/issues/4/comments');

    // Still on the board the next day (the day before is kept), and gone the day after.
    clockAt('2026-10-17T23:00:00Z');
    await build(output());
    expect(entries().map((e) => e.issue)).toEqual([2]);
    clockAt('2026-10-18T00:30:00Z');
    await build(output());
    expect(entries()).toEqual([]);
    expect(gh.writes()).toEqual([]);
  });

  it('fails rather than publish part of the list when there are more issues than it may read', async () => {
    fakeGitHub({ issues: Array.from({ length: ISSUE_PAGES * 100 }, (_, i) => issue(i + 1, null)) });
    writeFileSync(output(), '[{"kept":true}]\n');
    await expect(build(output())).rejects.toThrow(`More than ${ISSUE_PAGES * 100} issues match`);
    expect(readFileSync(output(), 'utf8')).toBe('[{"kept":true}]\n');
  });
});

describe('published list', () => {
  const pull = (id: string, score: number, submittedAt: string): RankableEntry => ({ id, setId: 'set-a', hand: 'Full House', multiplier: 7, score, submittedAt });
  const day = (date: string, n: number, base = 10) =>
    Array.from({ length: n }, (_, i) => pull(`${date}-${i}`, base + i, `${date}T${String(i % 24).padStart(2, '0')}:${String(Math.floor(i / 24)).padStart(2, '0')}:00.000Z`));

  it("keeps the build's UTC day and the day before on top of the all-time list", () => {
    const allTime = day('2026-10-01', HALL_OF_FAME_TOP + 10, 100_000); // fill the top 100 well above the daily pulls
    const verified = [...allTime, ...day('2026-10-14', 4), ...day('2026-10-15', 6), ...day('2026-10-16', HALL_OF_FAME_DAILY_TOP + 5)];
    const now = new Date('2026-10-16T00:30:00.000Z'); // just after midnight: yesterday is still kept
    const list = listToPublish(verified, now);
    const plain = hallOfFameList(verified);
    // The top 100 is unchanged; only extra entries follow it.
    expect(list.slice(0, plain.length)).toEqual(plain);
    expect(topPulls(list)).toEqual(topPulls(verified));
    const extra = list.slice(plain.length);
    expect(extra.filter((e) => e.submittedAt.startsWith('2026-10-16'))).toHaveLength(HALL_OF_FAME_DAILY_TOP);
    expect(extra.filter((e) => e.submittedAt.startsWith('2026-10-15'))).toHaveLength(6);
    expect(extra.filter((e) => e.submittedAt.startsWith('2026-10-14'))).toEqual([]);
    expect(dailyPulls(list, '2026-10-16')).toEqual(dailyPulls(verified, '2026-10-16'));
    // A build a minute before midnight keeps the 15th and the 14th instead.
    const before = listToPublish(verified, new Date('2026-10-15T23:59:00.000Z')).slice(plain.length);
    expect(new Set(before.map((e) => e.submittedAt.slice(0, 10)))).toEqual(new Set(['2026-10-15', '2026-10-14']));
  });
});

describe('verify-issue (issue workflow)', () => {
  const run = async (body: string, labels = ['hall-of-fame']) => {
    rmSync('github-output', { force: true });
    writeFileSync('event.json', JSON.stringify({ issue: { ...issue(7, null, { labels }), body } }));
    await verifyIssue();
    return { comment: readFileSync('hof-comment.md', 'utf8'), outputs: outputs() };
  };

  it('verifies a qualifying pull that would join the list, without writing to GitHub', async () => {
    const gh = fakeGitHub({ issues: [], published: [] });
    const result = await run(`My pull: ${link(fourOfAKind)}`);
    expect(result.outputs).toEqual({ verified: 'true', changed: 'true', redeploy: 'true', label: 'verified', rejected: 'false' });
    expect(result.comment).toContain('**Verified!**');
    expect(result.comment).toContain(marker(fourOfAKind));
    expect(gh.writes()).toEqual([]);
  });

  it("verifies a pull that only makes today's top 50 (labelled daily), and turns it down once that's full", async () => {
    clockAt('2026-10-16T12:00:00Z');
    const board = fakeGitHub({ issues: [], published: dailyOnlyBoard('2026-10-16', HALL_OF_FAME_DAILY_TOP - 1) });
    const joined = await run(link(fourOfAKind));
    expect(joined.outputs).toEqual({ verified: 'true', changed: 'true', redeploy: 'true', label: 'daily', rejected: 'false' });
    expect(joined.comment).toContain(marker(fourOfAKind));
    // A full day yesterday leaves today open.
    fakeGitHub({ issues: [], published: dailyOnlyBoard('2026-10-15', HALL_OF_FAME_DAILY_TOP) });
    expect((await run(link(fourOfAKind))).outputs).toEqual({ verified: 'true', changed: 'true', redeploy: 'true', label: 'daily', rejected: 'false' });

    const full = fakeGitHub({ issues: [], published: dailyOnlyBoard('2026-10-16', HALL_OF_FAME_DAILY_TOP) });
    const refused = await run(link(fourOfAKind));
    expect(refused.outputs).toEqual({ verified: 'false', changed: 'true', redeploy: 'false', label: 'verified', rejected: 'false' });
    expect(refused.comment).toContain('**Not added.**');
    expect(refused.comment).toContain(`the top ${HALL_OF_FAME_DAILY_TOP} of each UTC day`);
    expect(refused.comment).toContain('Brainrot Score above 20,000'); // today's 50th, below the top 100's 100th
    expect(refused.comment).not.toContain('hof-verified');
    expect([...board.writes(), ...full.writes()]).toEqual([]);
  });

  it("turns down a pull that only makes today's top while another issue from the last 8 days carries it under daily", async () => {
    clockAt('2026-10-16T12:00:00Z');
    const published = dailyOnlyBoard('2026-10-16', HALL_OF_FAME_DAILY_TOP - 1);
    const daily = (number: number, updated: string) => issue(number, fourOfAKind, { labels: ['hall-of-fame', 'daily'], updated });

    // Filed two days ago, it left the published list but must not count on today's top too.
    const again = fakeGitHub({ issues: [daily(5, '2026-10-14T09:00:00Z')], published });
    const refused = await run(link(fourOfAKind));
    expect(refused.outputs).toEqual({ verified: 'false', changed: 'true', redeploy: 'false', label: 'verified', rejected: 'false' });
    expect(refused.comment).toContain('**Not added.**');
    expect(refused.comment).toContain('counts on one day only');
    expect(refused.comment).not.toContain('hof-verified');

    // The issue itself, one past the 8 days, and one under another label don't hold it back.
    const own = fakeGitHub({ issues: [daily(7, '2026-10-16T11:00:00Z'), daily(5, '2026-10-08T11:59:59Z'), issue(6, fourOfAKind, { updated: '2026-10-15T00:00:00Z' })], published });
    expect((await run(link(fourOfAKind))).outputs).toEqual({ verified: 'true', changed: 'true', redeploy: 'true', label: 'daily', rejected: 'false' });
    // Nor does one whose display name isn't allowed: it's out of the list, so the pull may come back under a new name.
    const renamed = fakeGitHub({ issues: [issue(5, blockedName, { labels: ['hall-of-fame', 'daily'], updated: '2026-10-14T09:00:00Z' })], published });
    expect((await run(link(fourOfAKind))).outputs).toEqual({ verified: 'true', changed: 'true', redeploy: 'true', label: 'daily', rejected: 'false' });
    // Nor does a GitHub error: the pull goes ahead.
    const down = fakeGitHub({ issues: [daily(5, '2026-10-14T09:00:00Z')], published, fail: (r) => r.path === '/issues' });
    expect((await run(link(fourOfAKind))).outputs).toEqual({ verified: 'true', changed: 'true', redeploy: 'true', label: 'daily', rejected: 'false' });
    // A pull that joins the all-time list isn't checked.
    const allTime = fakeGitHub({ issues: [daily(5, '2026-10-14T09:00:00Z')], published: [] });
    expect((await run(link(fourOfAKind))).outputs).toEqual({ verified: 'true', changed: 'true', redeploy: 'true', label: 'verified', rejected: 'false' });
    expect(allTime.requests.some((r) => r.path === '/issues')).toBe(false);
    expect([again, own, renamed, down, allTime].flatMap((gh) => gh.writes())).toEqual([]);
  });

  it("turns down a real pull whose display name isn't allowed, and asks for the rejected label", async () => {
    const gh = fakeGitHub({ issues: [], published: [] });
    const result = await run(link(blockedName));
    expect(result.outputs).toEqual({ verified: 'false', changed: 'true', redeploy: 'false', label: 'verified', rejected: 'true' });
    expect(result.comment).toContain('**Not added.**');
    expect(result.comment).toContain("display name isn't allowed");
    expect(result.comment).not.toContain('hof-verified');
    expect(result.comment).not.toContain('xXfuckXx');
    expect(gh.writes()).toEqual([]);
  });

  it('changes nothing when the bot already verified the same pull on the issue and labels are in place', async () => {
    fakeGitHub({ issues: [], comments: { 7: [comment(BOT, marker(fourOfAKind), '2026-10-02T00:00:00Z')] } });
    expect((await run(link(fourOfAKind), ['hall-of-fame', 'verified'])).outputs).toEqual({ verified: 'true', changed: 'false', redeploy: 'false', label: 'verified', rejected: 'false' });
    // It keeps the label it has.
    expect((await run(link(fourOfAKind), ['hall-of-fame', 'daily'])).outputs).toEqual({ verified: 'true', changed: 'false', redeploy: 'false', label: 'daily', rejected: 'false' });
  });

  it('recovers from interrupted labeling: restores missing labels without duplicate comments and redeploys (#650)', async () => {
    // 1. Initial run: fresh submission with fourOfAKind
    const fakeIssue = issue(7, fourOfAKind, { labels: ['hall-of-fame'] });
    const gh = fakeGitHub({ issues: [fakeIssue], comments: {}, published: [] });

    // Step 1: verify-issue runs
    let result = await run(link(fourOfAKind), ['hall-of-fame']);
    expect(result.outputs).toEqual({ verified: 'true', changed: 'true', redeploy: 'true', label: 'verified', rejected: 'false' });
    expect(result.comment).toContain('**Verified!**');
    expect(result.comment).toContain(marker(fourOfAKind));

    // Simulate workflow shell execution:
    // Comment succeeds: bot adds comment to GitHub
    const commentBody = result.comment;
    gh.comments[7] = [comment(BOT, commentBody, '2026-10-02T10:00:00Z')];

    // Injected failure: labeling fails (e.g. runner interrupted or network error)
    // Issue labels remain only ['hall-of-fame'] (missing 'verified')!
    expect(fakeIssue.labels.map((l) => l.name)).toEqual(['hall-of-fame']);

    // At this point, build yields 0 entries because issue is not labeled verified/daily
    await build(output());
    expect(entries()).toHaveLength(0);

    // Step 2: Retry run (workflow reruns on the issue with marker comment present but labels missing)
    fakeIssue.updated_at = '2026-10-02T10:05:00Z';
    result = await run(link(fourOfAKind), ['hall-of-fame']);

    // Emits changed='true' so label step and redeploy run, but comment is empty so no duplicate comment!
    expect(result.outputs).toEqual({ verified: 'true', changed: 'true', redeploy: 'true', label: 'verified', rejected: 'false' });
    expect(result.comment).toBe(''); // empty: [ -s hof-comment.md ] skips comment!

    // Simulate workflow shell execution on retry:
    // Since hof-comment.md is empty, no duplicate comment is added:
    expect(gh.comments[7]).toHaveLength(1);

    // Labeling succeeds:
    fakeIssue.labels = [{ name: 'hall-of-fame' }, { name: 'verified' }];
    fakeIssue.state = 'closed';

    // Step 3: Now run build
    await build(output());
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toMatchObject({
      id: idOf(fourOfAKind),
      proof: fourOfAKind,
      submittedAt: '2026-10-02T10:00:00Z', // original comment timestamp preserved!
    });

    // Step 4: Subsequent retry on the completed issue changes nothing
    const completedResult = await run(link(fourOfAKind), ['hall-of-fame', 'verified']);
    expect(completedResult.outputs).toEqual({ verified: 'true', changed: 'false', redeploy: 'false', label: 'verified', rejected: 'false' });
  });

  describe('repairing the labels of a pull already verified on the issue (#650)', () => {
    // First verified late on the 16th, when that day's top had room; retried on the 17th.
    const markedAt = '2026-10-16T23:50:00Z';
    const marked = { 7: [comment(BOT, marker(fourOfAKind), markedAt)] };
    const allTime = { 7: [comment(BOT, marker(fourOfAKind), '2026-10-02T00:00:00Z')] };
    const seventeenthFull = dailyOnlyBoard('2026-10-17', HALL_OF_FAME_DAILY_TOP).filter((e) => e.id.startsWith('today-')).map((e) => ({ ...e, id: `17-${e.id}` }));
    /** This issue's own entry for the 4 of a Kind, as a deploy published it. */
    const ownEntry = (submittedAt: string) => ({ id: idOf(fourOfAKind), setId: 'lockdown-lore', hand: '4 of a Kind', multiplier: 250, score: 15_000, submittedAt, issue: 7 });
    beforeEach(() => clockAt('2026-10-17T12:00:00Z'));
    const REPAIR = { verified: 'true', changed: 'true', redeploy: 'true', label: 'daily', rejected: 'false' };

    it("isn't judged by any day's top again: it is daily unless it makes the top pulls, and redeploys only if the build would list it", async () => {
      for (const sixteenth of [HALL_OF_FAME_DAILY_TOP - 1, HALL_OF_FAME_DAILY_TOP]) {
        const gh = fakeGitHub({ issues: [], comments: marked, published: [...dailyOnlyBoard('2026-10-16', sixteenth), ...seventeenthFull] });
        const result = await run(link(fourOfAKind));
        // A full 16th keeps it off the build's list, so a deploy would change nothing.
        expect(result.outputs, `${sixteenth} on the 16th`).toEqual({ ...REPAIR, redeploy: String(sixteenth < HALL_OF_FAME_DAILY_TOP) });
        expect(result.comment).toBe('');
        expect(gh.writes()).toEqual([]);
      }
    });

    it('stays daily while another issue carries it under daily, without looking that issue up', async () => {
      const other = issue(5, fourOfAKind, { labels: ['hall-of-fame', 'daily'], updated: '2026-10-16T09:00:00Z' });
      const gh = fakeGitHub({ issues: [other], comments: marked, published: dailyOnlyBoard('2026-10-16', HALL_OF_FAME_DAILY_TOP - 1) });
      const result = await run(link(fourOfAKind));
      expect(result.outputs).toEqual(REPAIR);
      expect(result.comment).toBe('');
      expect(gh.requests.some((r) => r.path === '/issues')).toBe(false);
    });

    it('redeploys once when the run stopped before labelling (its verified comment is the latest), when it is not live', async () => {
      const gh = fakeGitHub({ issues: [], comments: allTime, published: [] });
      const result = await run(link(fourOfAKind), ['hall-of-fame']);
      expect(result.outputs).toEqual({ ...REPAIR, label: 'verified' });
      expect(result.comment).toBe('');
      // Labelled now: nothing more to do.
      expect((await run(link(fourOfAKind), ['hall-of-fame', 'verified'])).outputs).toMatchObject({ changed: 'false', redeploy: 'false' });
      expect(gh.writes()).toEqual([]);
    });

    /** Edits the issue away from the pull and back `times` times, posting the bot's comments as the workflow would. */
    const editAwayAndBack = async (gh: ReturnType<typeof fakeGitHub>, labels: string[], times = 3) => {
      const results = [];
      for (let i = 0; i < times; i++) {
        const away = await run('no link any more', labels);
        expect(away.outputs).toMatchObject({ verified: 'false', changed: 'true', redeploy: 'false' });
        gh.comments[7] = [...(gh.comments[7] ?? []), comment(BOT, away.comment, `2026-10-17T0${i}:00:00Z`)];
        results.push(await run(link(fourOfAKind), ['hall-of-fame', 'not-verified']));
      }
      return results;
    };

    it('labels it again after an edit away and back without starting a deploy, even when it is not live', async () => {
      const gh = fakeGitHub({ issues: [], comments: structuredClone(allTime), published: [] });
      for (const back of await editAwayAndBack(gh, ['hall-of-fame', 'verified'])) {
        expect(back.outputs).toEqual({ ...REPAIR, label: 'verified', redeploy: 'false' });
        expect(back.comment).toBe('');
      }
      expect(gh.writes()).toEqual([]);
    });

    it('starts no deploy for an expired daily pull, after an edit away and back or not', async () => {
      // Verified on the 14th, so the build of the 17th no longer lists it.
      const expired = { 7: [comment(BOT, marker(fourOfAKind), '2026-10-14T10:00:00Z')] };
      const published = dailyOnlyBoard('2026-10-16', HALL_OF_FAME_DAILY_TOP - 1);
      fakeGitHub({ issues: [], comments: structuredClone(expired), published });
      expect((await run(link(fourOfAKind))).outputs).toEqual({ ...REPAIR, redeploy: 'false' });
      const gh = fakeGitHub({ issues: [], comments: structuredClone(expired), published });
      for (const back of await editAwayAndBack(gh, ['hall-of-fame', 'daily'])) expect(back.outputs).toEqual({ ...REPAIR, redeploy: 'false' });
      expect(gh.writes()).toEqual([]);
    });

    it('starts no deploy for a pull outside the top pulls, after an edit away and back or not', async () => {
      // Verified on the 2nd, now below a full top 100 and on no recent day's top.
      const published = dailyOnlyBoard('2026-10-16', 0);
      fakeGitHub({ issues: [], comments: structuredClone(allTime), published });
      expect((await run(link(fourOfAKind))).outputs).toEqual({ ...REPAIR, redeploy: 'false' });
      const gh = fakeGitHub({ issues: [], comments: structuredClone(allTime), published });
      for (const back of await editAwayAndBack(gh, ['hall-of-fame', 'verified'])) expect(back.outputs).toEqual({ ...REPAIR, redeploy: 'false' });
      expect(gh.writes()).toEqual([]);
    });

    it("labels it daily and starts no deploy when the published list can't be read", async () => {
      const gh = fakeGitHub({ issues: [], comments: allTime });
      const result = await run(link(fourOfAKind));
      expect(result.outputs).toEqual({ ...REPAIR, redeploy: 'false' });
      expect(result.comment).toBe('');
      expect(gh.writes()).toEqual([]);
    });

    it('keeps a live entry its label after an edit away and back, judged without its own entry, and starts no deploy', async () => {
      // Live on the all-time list.
      const gh = fakeGitHub({ issues: [], comments: allTime, published: [ownEntry('2026-10-02T00:00:00Z')] });
      const away = await run('no link any more', ['hall-of-fame', 'verified']);
      expect(away.outputs).toMatchObject({ verified: 'false', changed: 'true', redeploy: 'false' });
      const back = await run(link(fourOfAKind), ['hall-of-fame', 'not-verified']);
      expect(back.outputs).toEqual({ ...REPAIR, label: 'verified', redeploy: 'false' });
      expect(back.comment).toBe('');
      expect(gh.writes()).toEqual([]);
      // Live on a day's top only: it stays daily.
      fakeGitHub({ issues: [], comments: marked, published: [...dailyOnlyBoard('2026-10-16', HALL_OF_FAME_DAILY_TOP - 1), ownEntry(markedAt)] });
      expect((await run(link(fourOfAKind), ['hall-of-fame', 'not-verified'])).outputs).toEqual({ ...REPAIR, redeploy: 'false' });
    });

    it('never relabels, closes or redeploys over `rejected`', async () => {
      const gh = fakeGitHub({ issues: [], comments: allTime, published: [] });
      for (const labels of [['hall-of-fame', 'not-verified', 'rejected'], ['hall-of-fame', 'rejected']]) {
        const result = await run(link(fourOfAKind), labels);
        expect(result.outputs, labels.join()).toEqual({ verified: 'true', changed: 'false', redeploy: 'false', label: 'verified', rejected: 'false' });
        expect(result.comment).toBe('');
      }
      expect(gh.writes()).toEqual([]);
    });
  });

  it("turns down a missing link, a forged pull, one that doesn't qualify, and one that wouldn't join", async () => {
    const pull = await verifyProof(fourOfAKind, getSet);
    const gh = fakeGitHub({ issues: [], published: [{ id: idOf(fourOfAKind), setId: pull.set.id, score: pull.score }] });
    const cases: [string, string][] = [
      ['just words', 'No pull link found'],
      [link(forged), "This pull didn't verify"],
      [link(pair), "doesn't qualify yet"],
      [link(fourOfAKind), 'already in the Hall of Fame'],
    ];
    for (const [body, reason] of cases) {
      const result = await run(body);
      expect(result.outputs).toEqual({ verified: 'false', changed: 'true', redeploy: 'false', label: 'verified', rejected: 'false' });
      expect(result.comment).toContain('**Not added.**');
      expect(result.comment).toContain(reason);
      expect(result.comment).not.toContain('hof-verified');
    }
    expect(gh.writes()).toEqual([]);
  });
});

describe('inbox (scheduled workflow)', () => {
  const relaysHold = (...proofs: string[]) => {
    const events = proofs.map((proof, i) => hallOfFameEvent(proof, idOf(proof), 1_000_000 + i * 1000));
    vi.mocked(fetchEvents).mockResolvedValue({ events, perRelay: [] });
    return events;
  };
  const FILED = ['POST /issues', 'POST /issues/100/comments', 'POST /issues/100/labels', 'PATCH /issues/100'];
  // Well inside the relay window; the fake GitHub stamps the issues it opens with this clock.
  beforeEach(() => clockAt('2026-10-16T12:00:00Z'));

  it('files a qualifying pull as a bot issue: open, marker comment, verified label, close', async () => {
    const gh = fakeGitHub({ issues: [], published: [] });
    const events = relaysHold(pair, fourOfAKind);
    await inbox();
    expect(gh.writes()).toEqual(FILED);
    const [opened, marked, labelled, closed] = gh.requests.filter((r) => r.method !== 'GET');
    expect(opened.body).toMatchObject({ labels: ['hall-of-fame'], title: '[Hall of Fame] 4 of a Kind by Combo Miner' });
    expect(opened.body!.body).toContain(`#/pull/${fourOfAKind}`);
    expect(marked.body!.body).toContain(marker(fourOfAKind));
    expect(labelled.body).toEqual({ labels: ['verified'] });
    expect(closed.body).toEqual({ state: 'closed', state_reason: 'completed' });
    expect(outputs()).toEqual({ added: '1' });
    expect(JSON.parse(readFileSync('hof-inbox-seen.json', 'utf8'))).toEqual(expect.arrayContaining(events.map((e) => e.id)));

    // The next run has seen both events and files nothing.
    gh.requests.length = 0;
    await inbox();
    expect(gh.writes()).toEqual([]);
    expect(outputs()).toEqual({ added: '0' });
  });

  it("files nothing for a pull whose display name isn't allowed", async () => {
    const gh = fakeGitHub({ issues: [], published: [] });
    relaysHold(blockedName);
    await inbox();
    expect(gh.writes()).toEqual([]);
    expect(outputs()).toEqual({ added: '0' });
  });

  it("files a pull again under a new name when its earlier issue's display name is now blocked", async () => {
    // The deploy drops that issue's entry, so it doesn't count as filed (verified, or unfinished).
    const gh = fakeGitHub({ issues: [issue(1, blockedName), issue(2, blockedName, { labels: ['hall-of-fame'], login: BOT, updated: '2026-10-12T00:00:00Z' })], published: [] });
    relaysHold(fourOfAKind);
    await inbox();
    expect(gh.writes()).toEqual(FILED);
    expect(outputs()).toEqual({ added: '1' });
  });

  it('files nothing for a pull already verified on an issue or already in the published list', async () => {
    const gh = fakeGitHub({ issues: [issue(1, fourOfAKind)], published: [] });
    relaysHold(fourOfAKind);
    await inbox();
    expect(gh.writes()).toEqual([]);

    rmSync('hof-inbox-seen.json');
    const pull = await verifyProof(fourOfAKind, getSet);
    const listed = fakeGitHub({ issues: [], published: [{ id: idOf(fourOfAKind), setId: pull.set.id, score: pull.score }] });
    await inbox();
    expect(listed.writes()).toEqual([]);
    expect(outputs()).toEqual({ added: '0' });

    // A `daily` issue counts too: it was changed within the relay window, so it is read.
    rmSync('hof-inbox-seen.json');
    const daily = fakeGitHub({ issues: [issue(1, fourOfAKind, { labels: ['hall-of-fame', 'daily'], updated: '2026-10-12T00:00:00Z' })], published: [] });
    await inbox();
    expect(daily.writes()).toEqual([]);
    expect(daily.requests.filter((r) => r.path === '/issues').map((r) => r.query)).toEqual([
      'state=all&labels=hall-of-fame,verified&per_page=100&page=1',
      'state=all&labels=hall-of-fame&since=2026-10-08T12:00:00Z&per_page=100&page=1',
    ]);
  });

  it("files a pull that only makes today's top with the daily label, and nothing once today's top is full", async () => {
    const gh = fakeGitHub({ issues: [], published: dailyOnlyBoard('2026-10-16', HALL_OF_FAME_DAILY_TOP - 1) });
    relaysHold(fourOfAKind);
    await inbox();
    expect(gh.writes()).toEqual(FILED);
    expect(gh.requests.find((r) => r.path === '/issues/100/labels')!.body).toEqual({ labels: ['daily'] });
    expect(outputs()).toEqual({ added: '1' });

    rmSync('hof-inbox-seen.json');
    const full = fakeGitHub({ issues: [], published: dailyOnlyBoard('2026-10-16', HALL_OF_FAME_DAILY_TOP) });
    await inbox();
    expect(full.writes()).toEqual([]);
    expect(outputs()).toEqual({ added: '0' });
  });

  it('finishes an issue a stopped run left unlabelled, instead of opening another', async () => {
    const fixture: Fixture = { issues: [], published: [], fail: (r) => r.method === 'POST' && r.path.endsWith('/labels') };
    const gh = fakeGitHub(fixture);
    relaysHold(fourOfAKind);
    await inbox();
    expect(gh.writes()).toEqual(FILED.slice(0, 3));
    expect(outputs()).toEqual({ added: '0' });

    fixture.fail = undefined;
    gh.requests.length = 0;
    await inbox();
    expect(gh.writes()).toEqual(['POST /issues/100/labels', 'PATCH /issues/100']);
    expect(gh.comments[100]).toHaveLength(1);
    expect(outputs()).toEqual({ added: '1' });
  });

  it("doesn't take over an unlabelled issue someone else opened", async () => {
    const gh = fakeGitHub({ issues: [issue(1, fourOfAKind, { labels: ['hall-of-fame'], login: 'mallory', updated: '2026-10-15T00:00:00Z' })], published: [] });
    relaysHold(fourOfAKind);
    await inbox();
    expect(gh.writes()).toEqual(FILED);
  });

  it('needs a token', async () => {
    vi.stubEnv('GITHUB_TOKEN', undefined);
    const gh = fakeGitHub({ issues: [] });
    await expect(inbox()).rejects.toThrow('GITHUB_TOKEN');
    expect(gh.requests).toEqual([]);
  });

  describe('run summary for ops-health (#715)', () => {
    const summary = () => JSON.parse(readFileSync('hof-inbox-summary.json', 'utf8')) as Record<string, unknown>;
    beforeEach(() => {
      vi.stubEnv('GITHUB_SHA', 'a'.repeat(40));
      vi.stubEnv('GITHUB_RUN_ID', '4242');
    });

    it('writes counts only, which ops-health reads back unchanged', async () => {
      fakeGitHub({ issues: [], published: [] });
      const events = relaysHold(pair, fourOfAKind);
      vi.mocked(fetchEvents).mockResolvedValue({ events, perRelay: [{ relay: 'wss://a', count: 2 }, { relay: 'wss://b', count: 0, error: 'timeout' }] });
      await inbox();
      const written = summary();
      expect(written).toEqual({
        v: 1, rev: 'a'.repeat(40), run: 4242, at: '2026-10-16T12:00:00.000Z', stage: 'done', outcome: 'ok',
        relays: { total: 2, failed: 1 }, read: 2, checked: 2, added: 1, deferred: 0, stop: null, oldestDeferredAgeS: null,
      });
      expect(parseInboxSummary(written)).toEqual(written);
      const text = readFileSync('hof-inbox-summary.json', 'utf8');
      for (const leak of [fourOfAKind, events[0].id, 'wss://', 'timeout', 'Combo Miner']) expect(text).not.toContain(leak);
    });

    it('still writes one, with the stage it stopped in, when the run fails', async () => {
      vi.stubEnv('GITHUB_TOKEN', undefined);
      await expect(inbox()).rejects.toThrow('GITHUB_TOKEN');
      expect(summary()).toMatchObject({ stage: 'relays', outcome: 'error', read: 0, added: 0, deferred: 0 });
      expect(parseInboxSummary(summary())).not.toBeNull();
    });
  });
});

describe('retention and intake contracts (offline)', () => {
  beforeEach(() => clockAt('2026-10-16T12:00:00Z'));
  const hinted = (proof: string, score: number, at: number) => hallOfFameEvent(proof, idOf(proof), at, score);
  const logged = () => vi.mocked(console.log).mock.calls.map((c) => String(c[0]));

  it('reads a list published before this change: no ids, a world first, and an unreadable entry', async () => {
    // As older builds wrote it: entries carry their proof but no id, and a set's first sits below the top.
    const old = dailyOnlyBoard('2026-10-16', HALL_OF_FAME_DAILY_TOP).map((e) => (e.id === 'first' ? { ...e, id: undefined, proof: fourOfAKind } : e));
    const published = [...old, { setId: 'x', score: 1, submittedAt: '2026-01-01T00:00:00.000Z', proof: 'not a proof' }];
    const gh = fakeGitHub({ issues: [], published });
    vi.mocked(fetchEvents).mockResolvedValue({ events: [hallOfFameEvent(fourOfAKind, idOf(fourOfAKind), 1_000_000)], perRelay: [] });
    await inbox();
    // Its id comes from the proof, so the pull counts as listed and isn't filed again.
    expect(gh.writes()).toEqual([]);
    expect(outputs()).toEqual({ added: '0' });

    writeFileSync('event.json', JSON.stringify({ issue: issue(7, fourOfAKind, { labels: [] }) }));
    await verifyIssue();
    expect(readFileSync('hof-comment.md', 'utf8')).toContain('already in the Hall of Fame');
  });

  it('turns away a pull whose claimed score is at or below the floor without checking it', async () => {
    // Both boards full: the floor is the day's 50th (20,000), below the all-time 100th.
    const gh = fakeGitHub({ issues: [], published: dailyOnlyBoard('2026-10-16', HALL_OF_FAME_DAILY_TOP) });
    const low = hinted(fourOfAKind, 20_000, 1_000_000);
    const lying = hinted(fourOfAKind, 1e9, 1_001_000);
    vi.mocked(fetchEvents).mockResolvedValue({ events: [low, lying], perRelay: [] });
    await inbox();
    expect(logged()).toContain(`${low.id}: claims 20000, at or below the floor of 20000; not checked`);
    // A higher claim is only a reason to check: the real score (15,000) still doesn't join.
    expect(logged().some((l) => l.startsWith(`${lying.id}:`) && l.includes('not checked'))).toBe(false);
    expect(gh.writes()).toEqual([]);
    expect(JSON.parse(readFileSync('hof-inbox-seen.json', 'utf8'))).toEqual(expect.arrayContaining([low.id, lying.id]));
  });

  it('judges each pull by the day its entry is stamped with, so a run that crosses UTC midnight moves to the new day', async () => {
    // The 16th's top is full; the 17th's has one place left, so the 4 of a Kind only joins once midnight passes.
    clockAt('2026-10-16T23:59:59Z');
    const tomorrow = dailyOnlyBoard('2026-10-17', HALL_OF_FAME_DAILY_TOP - 1).filter((e) => e.id.startsWith('today-'));
    const published = [...dailyOnlyBoard('2026-10-16', HALL_OF_FAME_DAILY_TOP), ...tomorrow.map((e) => ({ ...e, id: `tomorrow-${e.id}` }))];
    const gh = fakeGitHub({ issues: [], published });
    // Filing it fills the 17th's top, which raises the floor to its 15,000 for the events after it.
    const after = hinted(pair, 15_000, 1_002_000);
    vi.mocked(fetchEvents).mockResolvedValue({ events: [hallOfFameEvent(pair, idOf(pair), 1_000_000), hallOfFameEvent(fourOfAKind, idOf(fourOfAKind), 1_001_000), after], perRelay: [] });
    // The first line logged (turning the pair away) comes after the run read the list: midnight passes there.
    vi.mocked(console.log).mockImplementation(() => vi.setSystemTime(new Date('2026-10-17T00:00:05Z')));
    await inbox();
    expect(gh.writes()).toEqual(['POST /issues', 'POST /issues/100/comments', 'POST /issues/100/labels', 'PATCH /issues/100']);
    expect(gh.requests.find((r) => r.path === '/issues/100/labels')!.body).toEqual({ labels: ['daily'] });
    expect(logged()).toContain(`${after.id}: claims 15000, at or below the floor of 15000; not checked`);
    expect(outputs()).toEqual({ added: '1' });
  });

  describe("an issue a stopped run left unlabelled on the 16th, finished on the 17th", () => {
    // The 16th's top has one place left and the 17th's is full: the entry is stamped the 16th, so it joins there.
    const stamped = '2026-10-16T23:00:00Z';
    const unfinishedRun = () => {
      clockAt('2026-10-17T12:00:00Z');
      const seventeenth = dailyOnlyBoard('2026-10-17', HALL_OF_FAME_DAILY_TOP).filter((e) => e.id.startsWith('today-')).map((e) => ({ ...e, id: `17-${e.id}` }));
      const left = { ...issue(5, fourOfAKind, { labels: ['hall-of-fame'], login: BOT, updated: stamped }), created_at: stamped };
      return fakeGitHub({ issues: [left], published: [...dailyOnlyBoard('2026-10-16', HALL_OF_FAME_DAILY_TOP - 1), ...seventeenth] });
    };
    const FINISHED = ['POST /issues/5/comments', 'POST /issues/5/labels', 'PATCH /issues/5'];

    it("is judged and labelled by the 16th's top", async () => {
      const gh = unfinishedRun();
      vi.mocked(fetchEvents).mockResolvedValue({ events: [hallOfFameEvent(fourOfAKind, idOf(fourOfAKind), 1_000_000)], perRelay: [] });
      await inbox();
      expect(gh.writes()).toEqual(FINISHED);
      expect(gh.requests.find((r) => r.path === '/issues/5/labels')!.body).toEqual({ labels: ['daily'] });
      expect(outputs()).toEqual({ added: '1' });
    });

    it("isn't turned away by today's floor", async () => {
      // Today's floor is the 17th's 50th (20,000); the claim of 15,000 is at or below it.
      const gh = unfinishedRun();
      const event = hinted(fourOfAKind, 15_000, 1_000_000);
      vi.mocked(fetchEvents).mockResolvedValue({ events: [event], perRelay: [] });
      await inbox();
      expect(logged().some((l) => l.startsWith(`${event.id}:`) && l.includes('not checked'))).toBe(false);
      expect(gh.writes()).toEqual(FINISHED);
      expect(outputs()).toEqual({ added: '1' });
    });
  });

  it('keeps only the published list and the run caches, and never writes to public/', async () => {
    const tracked = path.join(home, 'public', 'hall-of-fame.json');
    const before = existsSync(tracked) ? readFileSync(tracked, 'utf8') : null;
    const gh = fakeGitHub({
      issues: [issue(1, fourOfAKind), issue(2, pair), issue(3, forged), issue(4, fourOfAKind, { labels: ['hall-of-fame', 'verified', 'rejected'] })],
      comments: { 1: [comment(BOT, marker(fourOfAKind), '2026-10-02T00:00:00Z')], 2: [comment(BOT, marker(pair), '2026-10-02T00:00:00Z')], 3: [comment(BOT, marker(forged), '2026-10-02T00:00:00Z')] },
      published: [],
    });
    await build(path.join(dir, 'hall-of-fame.json'));
    // Kept: the qualifying pull. Discarded: one that doesn't qualify, a forgery and a rejected issue.
    const list = JSON.parse(readFileSync('hall-of-fame.json', 'utf8')) as { issue: number }[];
    expect(list.map((e) => e.issue)).toEqual([1]);
    expect(readdirSync(dir).sort()).toEqual(['hall-of-fame.json', 'hof-build-cache.json']);

    vi.mocked(fetchEvents).mockResolvedValue({ events: [], perRelay: [] });
    await inbox();
    // The run's counts-only summary (#715) is the one other file it leaves.
    expect(readdirSync(dir).sort()).toEqual(['github-output', 'hall-of-fame.json', 'hof-build-cache.json', 'hof-inbox-seen.json', 'hof-inbox-summary.json']);
    expect(gh.writes()).toEqual([]);
    expect(existsSync(tracked) ? readFileSync(tracked, 'utf8') : null).toBe(before);
  });
});

describe('running as a script', () => {
  it('runs its command line when started through a symlink (no mode: usage, exit 2)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'hof-link-'));
    try {
      const link = path.join(dir, 'hall-of-fame.ts');
      symlinkSync(fileURLToPath(new URL('./hall-of-fame.ts', import.meta.url)), link);
      const tsx = createRequire(import.meta.url).resolve('tsx/cli');
      const run = spawnSync(process.execPath, [tsx, link], { encoding: 'utf8', timeout: 60_000 });
      expect(run.stderr).toContain('Usage: npx tsx scripts/hall-of-fame.ts');
      expect(run.status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
