// The Hall of Fame workflows' script (verify-issue, inbox, build) run against fixtures: GitHub's
// API, the deployed list and the Nostr relays are all faked, and files go to a temporary folder.
// Nothing here reaches the network or writes public/hall-of-fame.json.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vectors from '../spec/vectors.json';
import { getSet } from '../src/content/sets/index.ts';
import { decodeProof, pullId, verifyProof } from '../src/engine/index.ts';
import { fetchEvents, hallOfFameEvent } from '../src/game/nostrInbox.ts';
import { build, inbox, verifyIssue } from './hall-of-fame.ts';

vi.mock('../src/game/nostrInbox.ts', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), fetchEvents: vi.fn() }));

const BOT = 'github-actions[bot]';
const byNote = (note: string) => vectors.valid.find((v) => v.note === note)!.proof;
const fourOfAKind = byNote('mined 4 of a Kind'); // qualifies
const pair = byNote('simple'); // real, doesn't qualify
const forged = fourOfAKind.slice(0, -4) + (fourOfAKind.endsWith('AAAA') ? 'BBBB' : 'AAAA');
const idOf = (proof: string) => pullId(decodeProof(proof));
const marker = (proof: string) => `<!-- hof-verified ${idOf(proof)} -->`;
const link = (proof: string) => `https://evanlin23.github.io/BrainrotTCG/#/pull/${proof}`;

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
      const request: Request = { method, path: route, ...(body ? { body } : {}) };
      requests.push(request);
      if (fixture.fail?.(request)) return json({ message: 'Server Error' }, 500);
      const params = new URLSearchParams(query);
      const firstPage = (params.get('page') ?? '1') === '1';
      const byNumber = (n: string) => fixture.issues.find((i) => i.number === Number(n));

      if (route === '/issues' && method === 'GET') {
        const labels = (params.get('labels') ?? '').split(',').filter(Boolean);
        return json(firstPage ? fixture.issues.filter((i) => labels.every((l) => i.labels.some((x) => x.name === l))) : []);
      }
      if (route === '/issues' && method === 'POST') {
        const created: Issue = {
          number: next++,
          title: String(body!.title),
          body: String(body!.body),
          created_at: '2026-10-15T12:00:00Z',
          updated_at: '2026-10-15T12:00:00Z',
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
        const added = comment(BOT, String(body!.body), '2026-10-15T12:00:01Z');
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
  process.chdir(home);
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(unexpectedRequests).toEqual([]);
});

describe('build (deploy workflow)', () => {
  const output = () => path.join(dir, 'hall-of-fame.json');
  const entries = () => JSON.parse(readFileSync(output(), 'utf8')) as { issue: number; githubUser: string; submittedAt: string }[];

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

  it('reuses the result for an issue unchanged since the last deploy, and checks an edited one again', async () => {
    const fixture: Fixture = { issues: [issue(1, fourOfAKind)], comments: { 1: [comment(BOT, marker(fourOfAKind), '2026-10-02T00:00:00Z')] } };
    const gh = fakeGitHub(fixture);
    await build(output());
    expect(entries().map((e) => e.issue)).toEqual([1]);
    expect(existsSync('hof-build-cache.json')).toBe(true);

    gh.requests.length = 0;
    await build(output());
    expect(entries().map((e) => e.issue)).toEqual([1]);
    expect(gh.requests.map((r) => r.path)).toEqual(['/issues']); // listed, nothing re-checked

    // An edit swapped the pull for one that doesn't qualify.
    fixture.issues[0] = issue(1, pair, { updated: '2026-10-03T00:00:00Z' });
    await build(output());
    expect(entries()).toEqual([]);
  });
});

describe('verify-issue (issue workflow)', () => {
  const run = async (body: string) => {
    rmSync('github-output', { force: true });
    writeFileSync('event.json', JSON.stringify({ issue: { ...issue(7, null, { labels: ['hall-of-fame'] }), body } }));
    await verifyIssue();
    return { comment: readFileSync('hof-comment.md', 'utf8'), outputs: outputs() };
  };

  it('verifies a qualifying pull that would join the list, without writing to GitHub', async () => {
    const gh = fakeGitHub({ issues: [], published: [] });
    const result = await run(`My pull: ${link(fourOfAKind)}`);
    expect(result.outputs).toEqual({ verified: 'true', changed: 'true' });
    expect(result.comment).toContain('**Verified!**');
    expect(result.comment).toContain(marker(fourOfAKind));
    expect(gh.writes()).toEqual([]);
  });

  it('changes nothing when the bot already verified the same pull on the issue', async () => {
    fakeGitHub({ issues: [], comments: { 7: [comment(BOT, marker(fourOfAKind), '2026-10-02T00:00:00Z')] } });
    expect((await run(link(fourOfAKind))).outputs).toEqual({ verified: 'true', changed: 'false' });
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
      expect(result.outputs).toEqual({ verified: 'false', changed: 'true' });
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
    const gh = fakeGitHub({ issues: [issue(1, fourOfAKind, { labels: ['hall-of-fame'], login: 'mallory' })], published: [] });
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
