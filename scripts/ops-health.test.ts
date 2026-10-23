import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildReport, collect, DEFERRAL_RUNS, DEPLOY, DEPLOY_GRACE_S, formatReport, INBOX, INBOX_STALE_S, INBOX_SUMMARY_ARTIFACT, INBOX_SUMMARY_PATH,
  main, OUTPUT_PATH, parseInboxSummary, parseRuns, RUN_LIMIT, SUMMARY_LIMIT, type Gh, type InboxSummary, type Inputs, type Run, type State,
} from './ops-health.ts';

const NOW = new Date('2026-10-20T12:00:00Z');
const HEAD = 'c'.repeat(40);
const OLD = 'b'.repeat(40);
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();

let nextId = 1000;
/** A run as `gh run list --json` prints it, finished `minutes` ago. */
const ghRun = (conclusion: string | null, minutes: number, sha = HEAD, extra: Record<string, unknown> = {}) => ({
  databaseId: nextId++,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion: conclusion ?? '',
  createdAt: ago(minutes * 60 + 600),
  updatedAt: ago(minutes * 60),
  headSha: sha,
  ...extra,
});
const runs = (...items: ReturnType<typeof ghRun>[]): Run[] => parseRuns(items)!;
const summaryFor = (run: Run, deferred = 0, extra: Partial<InboxSummary> = {}): InboxSummary => ({
  v: 1, rev: run.sha, run: run.id, at: run.updatedAt, stage: 'done', outcome: 'ok', relays: { total: 5, failed: 0 },
  read: 40, checked: deferred ? 300 : 3, added: 0, deferred, stop: deferred ? 'budget' : null, oldestDeferredAgeS: deferred ? 5400 : null, ...extra,
});

/** Everything working: main's head deployed, the inbox ran 10 minutes ago and drained its queue. */
const healthy = (): Inputs => {
  const inbox = runs(ghRun('success', 10), ghRun('success', 25), ghRun('success', 40));
  return {
    now: NOW,
    head: { sha: HEAD, date: ago(3600) },
    runs: { [DEPLOY]: runs(ghRun('success', 30)), [INBOX]: inbox },
    intake: { runs: inbox.map((run) => ({ run, summary: summaryFor(run) })) },
  };
};
const states = (inputs: Inputs): Record<string, State> => Object.fromEntries(buildReport(inputs).conditions.map((c) => [c.key, c.state]));
const ALL_OK = { 'deploy-failing': 'ok', 'deploy-behind': 'ok', 'inbox-failing': 'ok', 'inbox-stale': 'ok', 'inbox-deferring': 'ok' };

describe('ops health conditions (#715)', () => {
  it('is all ok when the deploy is current and the inbox is running and draining', () => {
    expect(states(healthy())).toEqual(ALL_OK);
  });

  describe('failed runs', () => {
    it.each(['failure', 'cancelled', 'timed_out', 'skipped', 'startup_failure', 'action_required'])('a latest %s deploy is unhealthy', (conclusion) => {
      const inputs = healthy();
      inputs.runs[DEPLOY] = runs(ghRun(conclusion, 5), ghRun('success', 30));
      expect(states(inputs)['deploy-failing']).toBe('unhealthy');
      // The head was deployed by the earlier run, so it isn't behind.
      expect(states(inputs)['deploy-behind']).toBe('ok');
    });

    it('a latest failed or cancelled inbox run is unhealthy even when an earlier one succeeded recently', () => {
      for (const conclusion of ['failure', 'cancelled']) {
        const inputs = healthy();
        inputs.runs[INBOX] = runs(ghRun(conclusion, 5), ...inputs.runs[INBOX]!.map(() => ghRun('success', 20)));
        expect(states(inputs)).toMatchObject({ 'inbox-failing': 'unhealthy', 'inbox-stale': 'ok' });
      }
    });

    it('is unknown, not unhealthy, while a newer run is still going (a newer push cancels a deploy)', () => {
      const inputs = healthy();
      inputs.runs[DEPLOY] = runs(ghRun(null, 0), ghRun('cancelled', 5, OLD), ghRun('success', 60, OLD));
      inputs.head = { sha: HEAD, date: ago(600) };
      expect(states(inputs)).toMatchObject({ 'deploy-failing': 'unknown', 'deploy-behind': 'unknown' });
    });
  });

  describe('stale or missing runs', () => {
    it("is behind when main's head has waited past the grace with no successful deploy", () => {
      const inputs = healthy();
      inputs.runs[DEPLOY] = runs(ghRun('success', 300, OLD));
      inputs.head = { sha: HEAD, date: ago(DEPLOY_GRACE_S + 60) };
      const report = buildReport(inputs);
      expect(states(inputs)).toMatchObject({ 'deploy-failing': 'ok', 'deploy-behind': 'unhealthy' });
      expect(report.conditions.find((c) => c.key === 'deploy-behind')!.reason).toMatch(/^ccccccc landed 3 h ago and has no successful deploy; the last successful deploy is run \d+ \(bbbbbbb\) success 5 h ago$/);
      // Inside the grace it's pending, which neither opens nor closes the issue.
      inputs.head = { sha: HEAD, date: ago(DEPLOY_GRACE_S - 60) };
      expect(states(inputs)['deploy-behind']).toBe('unknown');
    });

    it('counts no deploy at all as behind, and a deploy stuck past the grace as behind too', () => {
      const inputs = healthy();
      inputs.runs[DEPLOY] = runs();
      inputs.head = { sha: HEAD, date: ago(DEPLOY_GRACE_S + 60) };
      expect(states(inputs)).toMatchObject({ 'deploy-failing': 'unknown', 'deploy-behind': 'unhealthy' });
      inputs.runs[DEPLOY] = runs(ghRun(null, 0), ghRun('success', 400, OLD));
      expect(states(inputs)).toMatchObject({ 'deploy-failing': 'ok', 'deploy-behind': 'unhealthy' });
    });

    it('is stale when the last successful inbox run is older than the limit, or there is none', () => {
      const inputs = healthy();
      inputs.runs[INBOX] = runs(ghRun('success', INBOX_STALE_S / 60 + 1));
      expect(states(inputs)['inbox-stale']).toBe('unhealthy');
      inputs.runs[INBOX] = runs(ghRun('failure', 5), ghRun('skipped', 20));
      expect(states(inputs)).toMatchObject({ 'inbox-stale': 'unhealthy', 'inbox-failing': 'unhealthy' });
      inputs.runs[INBOX] = runs();
      expect(states(inputs)).toMatchObject({ 'inbox-stale': 'unhealthy', 'inbox-failing': 'unknown' });
    });

    it("is unknown, never ok, when GitHub couldn't be read", () => {
      const report = buildReport({ now: NOW, head: null, runs: {}, intake: null });
      expect(report.conditions.map((c) => c.state)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
    });
  });

  describe('intake deferral, and partly observed intake', () => {
    const withSummaries = (...deferred: (number | null)[]) => {
      const inputs = healthy();
      inputs.intake = { runs: inputs.runs[INBOX]!.map((run, i) => ({ run, summary: deferred[i] === null ? null : summaryFor(run, deferred[i]!) })) };
      return inputs;
    };

    it(`is unhealthy only when each of the newest ${DEFERRAL_RUNS} successful runs left work for later`, () => {
      const inputs = withSummaries(12, 300, 7);
      expect(states(inputs)['inbox-deferring']).toBe('unhealthy');
      expect(buildReport(inputs).conditions.find((c) => c.key === 'inbox-deferring')!.reason).toBe(
        `the newest ${DEFERRAL_RUNS} successful runs each left work for later (12, 300, 7 events; stopped by budget)`,
      );
      expect(buildReport(inputs).intake).toMatchObject({ observed: 3, looked: 3, maxDeferred: 300, maxQueueAgeS: 5400, relayFailures: 0 });
    });

    it('is ok once the newest run drains its queue, even if older runs deferred or are unobserved', () => {
      expect(states(withSummaries(0, 300, null))['inbox-deferring']).toBe('ok');
    });

    it('is unknown when a summary is missing or expired: unseen work is not zero backlog', () => {
      expect(states(withSummaries(null, 0, 0))['inbox-deferring']).toBe('unknown');
      expect(states(withSummaries(5, null, 5))['inbox-deferring']).toBe('unknown');
      const few = withSummaries(5, 5, 5);
      few.intake!.runs = few.intake!.runs.slice(0, 2);
      expect(states(few)['inbox-deferring']).toBe('unknown');
      const report = buildReport(withSummaries(null, null, null));
      expect(report.intake).toEqual({ observed: 0, looked: 3, latest: null, maxDeferred: null, maxQueueAgeS: null, relayFailures: null });
      expect(formatReport(report)).toContain('Inbox summaries: 0 of 3 looked for');
      expect(formatReport(report)).toContain('a zero here is not an empty backlog');
    });
  });
});

describe('sanitizing what GitHub and the summaries hold', () => {
  const SECRET = ['player-key-ed25519', 'https://example.com/#/pull/AAAA', 'Error: boom', '<script>'];

  it('keeps only fixed words, ids, times, revisions and counts from run lists', () => {
    const listed = parseRuns([
      { ...ghRun('success', 5), displayTitle: SECRET[0], url: SECRET[1], headBranch: SECRET[2] },
      { ...ghRun(SECRET[3], 10), status: 'completed' },
      { ...ghRun(null, 0), status: SECRET[2] },
    ])!;
    expect(listed.map((r) => [r.status, r.conclusion])).toEqual([['other', null], ['completed', 'success'], ['completed', 'other']]);
    expect(JSON.stringify(listed)).not.toMatch(/player-key|example\.com|boom|script/);
  });

  it.each([
    ['not an array', { databaseId: 1 }],
    ['a bad id', [{ ...ghRun('success', 1), databaseId: -1 }]],
    ['a bad revision', [{ ...ghRun('success', 1), headSha: 'main; rm -rf /' }]],
    ['a bad time', [{ ...ghRun('success', 1), createdAt: 'yesterday' }]],
  ])('refuses a run list with %s', (_, value) => {
    expect(parseRuns(value)).toBeNull();
  });

  it('accepts a summary as the inbox writes it, and drops any extra field', () => {
    const run = runs(ghRun('success', 5))[0];
    const summary = summaryFor(run, 4);
    expect(parseInboxSummary({ ...summary, proof: SECRET[1], error: SECRET[2], relay: 'wss://relay' })).toEqual(summary);
  });

  it.each<[string, Record<string, unknown>]>([
    ['another version', { v: 2 }],
    ['free text in the stage', { stage: SECRET[2] }],
    ['free text in the stop reason', { stop: SECRET[2] }],
    ['a negative count', { deferred: -1 }],
    ['a fractional count', { read: 1.5 }],
    ['more failed relays than relays', { relays: { total: 1, failed: 2 } }],
    ['a short revision', { rev: 'abc1234' }],
    ['a time with an offset', { at: '2026-10-20T12:00:00+01:00' }],
    ['a text queue age', { oldestDeferredAgeS: '1h' }],
  ])('refuses a summary with %s', (_, change) => {
    const run = runs(ghRun('success', 5))[0];
    expect(parseInboxSummary({ ...summaryFor(run, 1), ...change })).toBeNull();
  });

  it('writes no player data, URLs or error text into the report or its step summary', () => {
    const inputs = healthy();
    const text = JSON.stringify(buildReport(inputs)) + formatReport(buildReport(inputs));
    for (const s of SECRET) expect(text).not.toContain(s);
    expect(text).not.toMatch(/https?:/);
  });
});

describe('collecting through a fake gh', () => {
  let dir: string;
  const home = process.cwd();
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ops-health-test-'));
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(home);
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  /**
   * Answers `gh run list` from `lists` (by workflow), `gh api .../commits/main` from `head` and
   * `gh run download` from `artifacts` (by run id, written where --dir says); anything else fails.
   */
  const fakeGh = (lists: Record<string, unknown>, artifacts: Record<number, unknown> = {}, head: unknown = { sha: HEAD, date: ago(3600) }) => {
    const calls: string[][] = [];
    const gh: Gh = (args) => {
      calls.push(args);
      const at = (flag: string) => args[args.indexOf(flag) + 1];
      if (args[0] === 'run' && args[1] === 'list') {
        if (!(at('--workflow') in lists)) throw new Error('HTTP 502');
        return JSON.stringify(lists[at('--workflow')]);
      }
      if (args[0] === 'api') return JSON.stringify(head);
      if (args[0] === 'run' && args[1] === 'download') {
        const artifact = artifacts[Number(args[2])];
        if (artifact === undefined || at('--name') !== INBOX_SUMMARY_ARTIFACT) throw new Error('no valid artifacts found to download');
        writeFileSync(path.join(at('--dir'), INBOX_SUMMARY_PATH), typeof artifact === 'string' ? artifact : JSON.stringify(artifact));
        return '';
      }
      throw new Error(`unexpected gh ${args.join(' ')}`);
    };
    return { gh, calls };
  };

  it(`reads at most ${RUN_LIMIT} runs per workflow on main and ${SUMMARY_LIMIT} summaries, newest successful runs first`, () => {
    const inbox = Array.from({ length: 10 }, (_, i) => ghRun(i === 1 ? 'failure' : 'success', 15 * i + 5));
    const parsed = runs(...inbox);
    const artifacts = Object.fromEntries(parsed.map((r) => [r.id, summaryFor(r)]));
    const { gh, calls } = fakeGh({ [DEPLOY]: [ghRun('success', 30)], [INBOX]: inbox, 'hall-of-fame.yml': [], 'test-order.yml': [], 'performance-baseline.yml': [] }, artifacts);
    const inputs = collect(gh, NOW);
    expect(states(inputs)).toEqual({ ...ALL_OK, 'inbox-failing': 'ok' });
    for (const call of calls.filter((c) => c[1] === 'list')) expect(call).toEqual(expect.arrayContaining(['--branch', 'main', '--limit', String(RUN_LIMIT)]));
    const downloads = calls.filter((c) => c[1] === 'download').map((c) => Number(c[2]));
    expect(downloads).toEqual(parsed.filter((r) => r.conclusion === 'success').slice(0, SUMMARY_LIMIT).map((r) => r.id));
  });

  it("counts a missing, malformed or another run's summary as unobserved", () => {
    const inbox = [ghRun('success', 5), ghRun('success', 20), ghRun('success', 35)];
    const [a, b] = runs(...inbox);
    const { gh } = fakeGh({ [DEPLOY]: [ghRun('success', 30)], [INBOX]: inbox }, { [a.id]: summaryFor(b, 9), [b.id]: '{not json' });
    const inputs = collect(gh, NOW);
    expect(inputs.intake!.runs.map((r) => r.summary)).toEqual([null, null, null]);
    expect(states(inputs)['inbox-deferring']).toBe('unknown');
  });

  it("treats a workflow it couldn't list as unknown, and the rest as read", () => {
    const { gh } = fakeGh({ [DEPLOY]: [ghRun('failure', 5)] }, {}, { message: 'Not Found' });
    expect(states(collect(gh, NOW))).toEqual({ 'deploy-failing': 'unhealthy', 'deploy-behind': 'unknown', 'inbox-failing': 'unknown', 'inbox-stale': 'unknown', 'inbox-deferring': 'unknown' });
  });

  it('writes ops-health.json and hands the issue job each condition as one JSON line', () => {
    vi.stubEnv('GITHUB_OUTPUT', path.join(dir, 'github-output'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { gh } = fakeGh({ [DEPLOY]: [ghRun('failure', 5)], [INBOX]: [ghRun('success', 5)] });
    expect(main(gh, NOW)).toBe(0);
    expect(JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'))).toMatchObject({ v: 1, at: NOW.toISOString(), head: { rev: 'ccccccc' } });
    const output = readFileSync('github-output', 'utf8');
    expect(output.split('\n').filter(Boolean)).toHaveLength(1);
    const conditions = JSON.parse(output.replace(/^conditions=/, '')) as { key: string; state: string; title: string }[];
    expect(conditions.map((c) => [c.key, c.state])).toEqual([
      ['deploy-failing', 'unhealthy'], ['deploy-behind', 'unknown'], ['inbox-failing', 'ok'], ['inbox-stale', 'ok'], ['inbox-deferring', 'unknown'],
    ]);
    expect(conditions[0].title).toBe('Ops health: the latest deploy of main did not succeed');
  });
});
