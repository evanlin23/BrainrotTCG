/**
 * Offline fixture tests for Hall of Fame intake (`hall-of-fame.ts inbox`, `hof-inbox.ts`) and the
 * snapshot the deploy publishes (`hall-of-fame.ts build`). Unlike hall-of-fame.test.ts, nothing in the
 * scripts is mocked: the real relay reader, inbox and build run against in-memory GitHub and Nostr
 * relays (scripts/fixtures/hof/adapters.ts). `fetch` and `WebSocket` reach only those fakes, so any
 * other request fails the test. No tokens, no network, no live writes.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vectors from '../spec/vectors.json';
import { getSet } from '../src/content/sets/index.ts';
import { decodeProof, pullId } from '../src/engine/index.ts';
import { fetchEvents, hallOfFameEvent, HOF_KIND, HOF_RELAYS, HOF_TAG, signEvent, type NostrEvent } from '../src/game/nostrInbox.ts';
import { BOT, FakeGitHub, FakeRelays, offlineNetwork, type FakeComment, type FakeIssue, type GitHubRequest, type RelayFixture } from './fixtures/hof/adapters.ts';
import { build, inbox } from './hall-of-fame.ts';
import { processInbox } from './hof-inbox.ts';

// Count signature checks (schnorr is frozen, so it can't be spied on in place).
vi.mock('@noble/curves/secp256k1.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noble/curves/secp256k1.js')>();
  return { ...actual, schnorr: { ...actual.schnorr, verify: vi.fn(actual.schnorr.verify) } };
});

/** The frozen clock (only `Date`; timers stay real so the relay reader's timeouts work). */
const NOW = Date.parse('2026-10-16T12:00:00Z');
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

const valid = (note: string) => vectors.valid.find((v) => v.note === note)!.proof;
const invalid = (note: string) => (vectors.invalid as { note: string; proof?: string }[]).find((v) => v.note === note)!.proof!;
const fourOfAKind = valid('mined 4 of a Kind'); // 15,000: the only vector that qualifies
const pair = valid('simple'); // real, doesn't qualify
const twoPair = valid('mined Two Pair');
const threeOfAKind = valid('mined 3 of a Kind');
const forged = fourOfAKind.slice(0, -4) + (fourOfAKind.endsWith('AAAA') ? 'BBBB' : 'AAAA');
const idOf = (proof: string) => pullId(decodeProof(proof));
/** The bot's marker as it was before it recorded receipts. */
const marker = (proof: string) => `<!-- hof-verified ${idOf(proof)} -->`;
/** Whether a comment carries the bot's marker for `proof`, with a receipt or without. */
const marks = (body: string | null | undefined, proof: string) => !!body && (body.includes(marker(proof)) || body.includes(`<!-- hof-verified ${idOf(proof)} received `));
const link = (proof: string) => `https://evanlin23.github.io/BrainrotTCG/#/pull/${proof}`;

/** A submission as the site sends it (a fresh key each time), `secondsAgo` before NOW. */
const submit = (proof: string, secondsAgo = 60, score?: number) => hallOfFameEvent(proof, idOf(proof), NOW - secondsAgo * 1000, score);

const key = schnorr.utils.randomSecretKey();
const pubkey = Buffer.from(schnorr.getPublicKey(key)).toString('hex');
/** A correctly signed event with any content, tags and kind: what a buggy or hostile client can send. */
const signed = (content: string, { secondsAgo = 120, tags = [['t', HOF_TAG]], kind = HOF_KIND } = {}): NostrEvent =>
  signEvent({ pubkey, created_at: Math.floor(NOW / 1000) - secondsAgo, kind, tags, content }, key);

/** Every relay the inbox reads, empty unless a fixture is given for it. */
const relays = (fixtures: Record<string, RelayFixture> = {}) => new FakeRelays(Object.fromEntries(HOF_RELAYS.map((r) => [r, fixtures[r] ?? {}])));
/** Every relay serving the same events. */
const everywhere = (events: NostrEvent[]) => relays(Object.fromEntries(HOF_RELAYS.map((r) => [r, { events }])));

const labels = (...names: string[]) => names.map((name) => ({ name }));
/** A Hall of Fame issue a player opened a day ago, labelled verified unless said otherwise. */
const issue = (number: number, proof: string | null, extra: Partial<FakeIssue> = {}): FakeIssue => ({
  number,
  title: `[Hall of Fame] #${number}`,
  body: proof === null ? null : `${link(proof)}\n`,
  created_at: at(86400),
  updated_at: at(86400),
  user: { login: 'alice' },
  labels: labels('hall-of-fame', 'verified'),
  ...extra,
});
/** The bot's verified comment (its marker is what `build` looks for). */
const verifiedBy = (proof: string, secondsAgo: number, login = BOT): FakeComment => ({ body: `✅ **Verified!**\n${marker(proof)}`, created_at: at(secondsAgo), user: { login } });
const names = (i: FakeIssue) => i.labels.map((l) => l.name);
const FILING = ['POST /issues', 'POST /issues/100/comments', 'POST /issues/100/labels', 'PATCH /issues/100'];

/** Each line the runs appended to $GITHUB_OUTPUT. */
const outputs = () => (existsSync('github-output') ? readFileSync('github-output', 'utf8').trim().split('\n') : []);

let home: string;
let dir: string;
let logs: string[];
let net: ReturnType<typeof offlineNetwork>;
beforeEach(() => {
  home = process.cwd();
  dir = mkdtempSync(path.join(os.tmpdir(), 'hof-intake-'));
  // The script keeps its caches in the working folder, as on a runner.
  process.chdir(dir);
  vi.stubEnv('GITHUB_TOKEN', 'test-token'); // only ever reaches the fake
  vi.stubEnv('GITHUB_OUTPUT', path.join(dir, 'github-output'));
  vi.stubEnv('SITE_URL', undefined);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  logs = [];
  const capture = (...args: unknown[]) => void logs.push(args.map(String).join(' '));
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  net = offlineNetwork();
});
afterEach(() => {
  vi.useRealTimers();
  process.chdir(home);
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // The scripts catch some network errors, so a refused request is only caught here.
  expect(net.blocked).toEqual([]);
});

describe('inbox: duplicate submissions', () => {
  it('files a pull once, however many relays, keys and runs carry it', async () => {
    net.relays = everywhere([submit(fourOfAKind, 600), submit(fourOfAKind, 300)]); // the second from another device
    const gh = (net.github = new FakeGitHub());
    await inbox();

    // A second page brings only the oldest event again, at its `until`; a third steps past it, empty.
    expect(net.relays.requests).toHaveLength(HOF_RELAYS.length * 3);
    expect(net.relays.requests[0].filter).toEqual({ kinds: [HOF_KIND], '#t': [HOF_TAG], since: NOW / 1000 - 7 * 24 * 60 * 60, limit: 100 });
    expect(gh.writes()).toEqual(FILING);
    const [filed] = gh.botIssues();
    expect(names(filed)).toEqual(['hall-of-fame', 'verified']);
    expect(filed.state).toBe('closed');
    expect(filed.body).toContain(`#/pull/${fourOfAKind}\n`);
    expect(gh.comments[100].filter((c) => marks(c.body, fourOfAKind))).toHaveLength(1);
    expect(logs).toContain('2 events read, 1 added');

    // Run again, then again after losing the cache of seen events: GitHub says it's filed.
    await inbox();
    rmSync('hof-inbox-seen.json');
    await inbox();
    expect(gh.writes()).toEqual(FILING);
    expect(gh.botIssues()).toHaveLength(1);
    expect(outputs()).toEqual(['added=1', 'added=0', 'added=0']);
  });

  it.each([
    { on: ['hall-of-fame', 'verified'] },
    { on: ['hall-of-fame', 'daily'] },
    { on: ['hall-of-fame', 'verified', 'rejected'] }, // rejected by the owner: sending it again doesn't bring it back
  ])('leaves a pull already on an issue labelled $on alone', async ({ on }) => {
    net.relays = everywhere([submit(fourOfAKind)]);
    const gh = (net.github = new FakeGitHub([issue(1, fourOfAKind, { labels: labels(...on) })], { 1: [verifiedBy(fourOfAKind, 80000)] }));
    await inbox();
    expect(gh.writes()).toEqual([]);
    expect(outputs()).toEqual(['added=0']);
    expect(JSON.parse(readFileSync('hof-inbox-seen.json', 'utf8'))).toHaveLength(1);
  });

  it("files a pull whose only other issue never verified (someone else's copy can't block it)", async () => {
    net.relays = everywhere([submit(fourOfAKind)]);
    const gh = (net.github = new FakeGitHub([issue(1, fourOfAKind, { labels: labels('hall-of-fame'), user: { login: 'mallory' } })]));
    await inbox();
    expect(gh.writes()).toEqual(FILING);
    expect(names(gh.issues[0])).toEqual(['hall-of-fame']);
  });
});

describe('inbox: malformed relay data', () => {
  it('files only the real pull out of junk frames, bad events, bad content and failing proofs', async () => {
    const real = submit(fourOfAKind, 60);
    const tampered = { ...real, sig: (real.sig[0] === '0' ? '1' : '0') + real.sig.slice(1) }; // same id, bad signature
    const wrongTag = signed(JSON.stringify({ v: 1, proof: fourOfAKind }), { tags: [['t', 'something-else']] });
    const wrongKind = signed(JSON.stringify({ v: 1, proof: fourOfAKind }), { kind: 1 });
    // Junk ignores the filter, as a misbehaving relay can; the tampered copy comes before the real one.
    const junk = (sub: string) => [
      'not json',
      JSON.stringify(['NOTICE', 'slow down']),
      JSON.stringify(['EVENT', sub, { id: 'xyz', kind: HOF_KIND }]),
      JSON.stringify(['EVENT', sub, tampered]),
      JSON.stringify(['EVENT', sub, wrongTag]),
      JSON.stringify(['EVENT', sub, wrongKind]),
      JSON.stringify(['EVENT', 'another-sub', submit(fourOfAKind, 10)]),
      JSON.stringify(['EOSE', 'another-sub']),
    ];
    const badContent = [
      signed('not json', { secondsAgo: 200 }),
      signed(JSON.stringify({ v: 2, proof: fourOfAKind })),
      signed(JSON.stringify({ v: 1, proof: ` ${fourOfAKind}` })),
      signed(JSON.stringify({ v: 1, proof: link(fourOfAKind) })),
      signed(JSON.stringify({ v: 1, proof: 42 })),
      signed(JSON.stringify({ v: 1, proof: invalid('truncated') })),
      signed(JSON.stringify({ v: 1, proof: fourOfAKind, score: 'lots' }), { tags: [['t', 'x'], ['t', HOF_TAG]], secondsAgo: 30 }), // a valid submission after all
    ];
    // The forged copy is older than the real one, so it is checked first and must not block it.
    const failing = [submit(forged, 70), submit(pair, 40), submit(invalid('name with a trailing space'), 35)];
    const served = [...badContent, ...failing, real];
    net.relays = relays({
      [HOF_RELAYS[0]]: { events: served, junk },
      [HOF_RELAYS[1]]: { events: served },
      [HOF_RELAYS[2]]: { events: served },
      [HOF_RELAYS[3]]: { closedWith: 'rate-limited\n::error::pwned' },
      [HOF_RELAYS[4]]: { down: true },
    });
    const gh = (net.github = new FakeGitHub());
    await inbox();

    expect(gh.writes()).toEqual(FILING);
    expect(gh.botIssues()[0].body).toContain(`#/pull/${fourOfAKind}\n`);
    expect(logs).toContain(`${HOF_RELAYS[3]}: 0 events (rate-limited ::error::pwned)`);
    expect(logs).toContain(`${HOF_RELAYS[4]}: 0 events (connection failed)`);
    expect(logs.filter((l) => l.includes("didn't verify"))).toHaveLength(2);
    expect(logs).toContain(`${failing[1].id}: Pair, 120 doesn't make the Hall of Fame`);
    // Read: the signed matching events (bad content, failing, real); not the off-filter tag/kind, tampered copy or other subscription's.
    expect(logs).toContain(`${served.length} events read, 1 added`);
    expect(logs.join('\n')).not.toMatch(/(^|\n)::/);

    // Everything was handled: the next run re-derives nothing and files nothing.
    logs.length = 0;
    await inbox();
    expect(logs.some((l) => l.includes("didn't verify") || l.includes("doesn't make"))).toBe(false);
    expect(gh.writes()).toEqual(FILING);
  });
});

describe('inbox: signature checks (#1000)', () => {
  it('checks the signature of each event it handles once, and none of the events it has handled', async () => {
    const real = submit(fourOfAKind, 60);
    const badSig = { ...real, sig: (real.sig[0] === '0' ? '1' : '0') + real.sig.slice(1) };
    const served = [submit(pair, 300), submit(forged, 200), submit(invalid('unknown set'), 100), real];
    // One relay serves the real event with a bad signature first; the copy that verifies is kept.
    net.relays = relays({ ...Object.fromEntries(HOF_RELAYS.map((r) => [r, { events: served }])), [HOF_RELAYS[0]]: { events: [badSig, ...served.slice(0, -1)] } });
    const gh = (net.github = new FakeGitHub());
    vi.mocked(schnorr.verify).mockClear();
    await inbox();
    expect(gh.writes()).toEqual(FILING);
    // One check per event handled, and one for the copy that differs from the kept one.
    expect(vi.mocked(schnorr.verify).mock.calls.length).toBe(served.length + 1);

    // Read again on every run, but already handled: no signature is checked.
    net.relays = everywhere(served);
    vi.mocked(schnorr.verify).mockClear();
    await inbox();
    expect(vi.mocked(schnorr.verify).mock.calls.length).toBe(0);
    expect(gh.writes()).toEqual(FILING);
  });
});

describe('inbox: per-run caps', () => {
  it('stops re-deriving pulls at the run budget and picks the rest up next run', async () => {
    // 300 submissions that decode but fail to verify, all older than one real pull.
    const cheap = ['name with a trailing space', 'name not normalised (double space)', 'unknown set', 'signature byte flipped'].map(invalid);
    const flood = Array.from({ length: 300 }, (_, i) => submit(cheap[i % cheap.length], 3600 + i));
    const real = submit(fourOfAKind, 60);
    net.relays = relays({ [HOF_RELAYS[0]]: { events: [...flood, real] } });
    const gh = (net.github = new FakeGitHub());
    await inbox();

    // 100 events a request, so the relay was paged (`until` the oldest so far).
    expect(net.relays.requests.filter((r) => r.relay === HOF_RELAYS[0] && r.filter.until !== undefined).length).toBeGreaterThanOrEqual(3);
    expect(logs).toContain('301 events read, 0 added');
    expect(logs).toContain('1 events left for the next run');
    expect(logs.filter((l) => l.includes("didn't verify"))).toHaveLength(300);
    expect(gh.writes()).toEqual([]);
    expect(JSON.parse(readFileSync('hof-inbox-seen.json', 'utf8'))).toHaveLength(300);

    logs.length = 0;
    await inbox();
    expect(logs.filter((l) => l.includes("didn't verify"))).toHaveLength(0);
    expect(gh.writes()).toEqual(FILING);
    expect(outputs()).toEqual(['added=0', 'added=1']);
  });

  // Only one test vector qualifies, so the per-run cap on filings (20 in `inbox`) is driven through
  // processInbox, with every verified pull accepted, over events read by the real relay reader.
  it('files at most maxFiled pulls a run, the rest on later runs, each once', async () => {
    net.relays = everywhere([submit(pair, 400), submit(twoPair, 300), submit(threeOfAKind, 200), submit(pair, 100)]);
    const { events } = await fetchEvents({ kinds: [HOF_KIND], '#t': [HOF_TAG], limit: 100 }, HOF_RELAYS, 5000, undefined, 50);
    expect(events).toHaveLength(4);
    const seen = new Set<string>();
    const filed = new Set<string>();
    const runs: { filed: string[]; result: { added: number; deferred: number } }[] = [];
    for (let run = 0; run < 4; run++) {
      const now: string[] = [];
      const file = async (_proof: string, pull: { score: { hand: { name: string } } }) => void now.push(pull.score.hand.name);
      const result = await processInbox(events, { seen, filed, budget: 300, maxFiled: 1, lookup: getSet, accepts: () => true, file });
      runs.push({ filed: now, result });
    }
    expect(runs).toEqual([
      { filed: ['Pair'], result: { added: 1, deferred: 3 } },
      { filed: ['Two Pair'], result: { added: 1, deferred: 2 } },
      { filed: ['3 of a Kind'], result: { added: 1, deferred: 0 } }, // the second Pair is already filed
      { filed: [], result: { added: 0, deferred: 0 } },
    ]);
  });
});

describe('inbox: interrupted runs', () => {
  it.each([
    { step: 'opening the issue', fail: (r: GitHubRequest) => r.method === 'POST' && r.path === '/issues' },
    { step: 'posting the verified comment', fail: (r: GitHubRequest) => r.method === 'POST' && r.path.endsWith('/comments') },
    { step: 'adding the label', fail: (r: GitHubRequest) => r.path.endsWith('/labels') },
    { step: 'closing the issue', fail: (r: GitHubRequest) => r.method === 'PATCH' },
  ])('finishes the pull on one issue after a run stopped at $step', async ({ step, fail }) => {
    net.relays = everywhere([submit(fourOfAKind)]);
    const gh = (net.github = new FakeGitHub());
    gh.fail = fail;
    await inbox();
    expect(logs.some((l) => l.includes("couldn't file it") || l.includes("couldn't close it"))).toBe(true);

    // GitHub recovers; the next scheduled runs come an hour apart.
    gh.fail = () => false;
    for (const hours of [1, 2]) {
      vi.setSystemTime(NOW + hours * 3600_000);
      await inbox();
    }

    expect(gh.botIssues()).toHaveLength(1);
    const [filed] = gh.botIssues();
    expect(names(filed)).toEqual(['hall-of-fame', 'verified']);
    if (step !== 'closing the issue') expect(filed.state).toBe('closed');
    const markers = gh.comments[filed.number].filter((c) => c.user?.login === BOT && marks(c.body, fourOfAKind));
    expect(markers).toHaveLength(1);
    expect(outputs().reduce((n, line) => n + Number(line.split('=')[1]), 0)).toBe(1);

    // The deploy publishes it once, credited to Nostr, received when the issue was filed and verified
    // by its one marker (a comment a later run posted, if the first stopped before it).
    await build(path.join(dir, 'hall-of-fame.json'));
    const entries = JSON.parse(readFileSync(path.join(dir, 'hall-of-fame.json'), 'utf8')) as { issue: number; githubUser: string; submittedAt: string; verifiedAt: string; receipt?: string }[];
    expect(entries.map((e) => [e.issue, e.githubUser, e.submittedAt, e.verifiedAt, e.receipt])).toEqual([[filed.number, 'nostr', filed.created_at, markers[0].created_at, undefined]]);
  });
});

describe('build: the published snapshot', () => {
  const output = () => path.join(dir, 'hall-of-fame.json');
  const entries = () => JSON.parse(readFileSync(output(), 'utf8')) as { issue: number; githubUser: string; submittedAt: string }[];

  it('leaves out issues labelled rejected', async () => {
    const gh = (net.github = new FakeGitHub(
      [issue(1, fourOfAKind, { labels: labels('hall-of-fame', 'verified', 'rejected') }), issue(2, fourOfAKind, { user: { login: 'bob' } })],
      { 1: [verifiedBy(fourOfAKind, 90000)], 2: [verifiedBy(fourOfAKind, 80000)] },
    ));
    await build(output());
    // #1 was verified first, but it's rejected, so #2 has the pull; #1's comments are read once,
    // only for the withdrawn list's markers.
    expect(entries().map((e) => [e.issue, e.githubUser])).toEqual([[2, 'bob']]);
    expect(gh.requests.filter((r) => r.path.startsWith('/issues/1/')).map((r) => r.path)).toEqual(['/issues/1/comments']);

    gh.issues[1].labels.push({ name: 'rejected' });
    gh.issues[1].updated_at = at(10);
    await build(output());
    expect(readFileSync(output(), 'utf8')).toBe('[]\n');
  });

  it('keeps a pull out once its inbox issue is rejected, even when it is sent again', async () => {
    net.relays = everywhere([submit(fourOfAKind, 600)]);
    const gh = (net.github = new FakeGitHub());
    await inbox();
    await build(output());
    expect(entries().map((e) => e.githubUser)).toEqual(['nostr']);

    const [filed] = gh.botIssues();
    filed.labels.push({ name: 'rejected' });
    filed.updated_at = new Date().toISOString();
    // Sent again from another device, after the cache of seen events was lost.
    vi.setSystemTime(NOW + 3600_000);
    net.relays = everywhere([submit(fourOfAKind, 600), submit(fourOfAKind, 30)]);
    rmSync('hof-inbox-seen.json');
    await inbox();
    expect(gh.writes()).toEqual(FILING);
    await build(output());
    expect(readFileSync(output(), 'utf8')).toBe('[]\n');
  });

  it('publishes only issues whose body carries a real, qualifying pull the bot verified there', async () => {
    const gh = (net.github = new FakeGitHub(
      [
        issue(1, null),
        { ...issue(2, null), body: 'my pull was great, trust me' },
        issue(3, invalid('truncated')),
        issue(4, forged),
        issue(5, pair),
        issue(6, fourOfAKind), // marked only by someone imitating the bot
        { ...issue(7, fourOfAKind), pull_request: {} }, // a pull request, not an issue
        issue(8, fourOfAKind, { user: { login: 'carol' } }),
      ],
      { 6: [verifiedBy(fourOfAKind, 90000, 'mallory')], 7: [verifiedBy(fourOfAKind, 90000)], 8: [verifiedBy(fourOfAKind, 80000)] },
    ));
    await build(output());
    expect(entries().map((e) => [e.issue, e.githubUser])).toEqual([[8, 'carol']]);
    for (const n of [1, 2, 3, 4, 5, 6]) expect(logs.some((l) => l.startsWith(`#${n}: skipped (`))).toBe(true);
    expect(gh.requests.some((r) => r.path.startsWith('/issues/7'))).toBe(false);
    expect(logs.join('\n')).not.toMatch(/(^|\n)::/);
  });

  it('writes byte-identical hall-of-fame.json on repeated runs over the same issues', async () => {
    const fixture = (reverse = false) => {
      const issues = [
        issue(1, fourOfAKind), // the first verification keeps the credit
        issue(2, fourOfAKind, { user: { login: BOT }, created_at: at(3600), updated_at: at(3600) }),
        issue(3, fourOfAKind, { user: { login: 'bob' }, labels: labels('hall-of-fame', 'verified', 'rejected') }),
        issue(4, pair),
        issue(5, forged),
        issue(6, fourOfAKind, { labels: labels('hall-of-fame', 'daily'), updated_at: at(7200) }),
      ];
      const comments = { 1: [verifiedBy(fourOfAKind, 86000)], 2: [verifiedBy(fourOfAKind, 3500)], 3: [verifiedBy(fourOfAKind, 90000)], 6: [verifiedBy(fourOfAKind, 7000)] };
      return new FakeGitHub(reverse ? issues.reverse() : issues, comments);
    };
    const run = async () => {
      await build(output());
      return { list: readFileSync(output()), cache: readFileSync('hof-build-cache.json') };
    };

    net.github = fixture();
    const first = await run();
    const cached = await run(); // every issue unchanged: all from the cache
    rmSync('hof-build-cache.json');
    net.github = fixture(true); // a cold cache, issues listed in the other order
    const cold = await run();

    expect(JSON.parse(first.list.toString()).map((e: { issue: number }) => e.issue)).toEqual([1]);
    expect(logs).toContain('5 verified issues (5 unchanged since the last deploy) -> 1 entries in public/hall-of-fame.json');
    expect(cached.list.equals(first.list)).toBe(true);
    expect(cold.list.equals(first.list)).toBe(true);
    expect(cached.cache.equals(first.cache)).toBe(true);
    expect(cold.cache.equals(first.cache)).toBe(true);
  });
});
