import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BUDGET, JOURNEYS, MAX_HOTSPOT_CHARS, MAX_STATE_CHARS, MAX_STATE_ISSUES, REVIEW_CRITERIA, collectSignals, decideDue,
  formatReview, formatState, lastCommitDay, main, mainChecks, mainRev, overallStatus, parseState, pickHotspot, pickJourney, planSlice,
  recordRun, review, touchedJourneys,
  type Change, type FileRead, type GitInfo, type GitRun, type MainChecks, type ReadFile, type ReviewState, type Tools,
} from './quality-review.ts';

const NOW = new Date('2026-10-22T09:00:00Z');
const ALL_TOOLS: Tools = { claude: true, chromium: true };
const state = (overrides: Partial<ReviewState> = {}): ReviewState => ({
  cadenceDays: 7, budget: { ...DEFAULT_BUDGET }, issues: [], ...overrides,
});
const passed = state({
  lastStatus: 'pass', lastDate: '2026-10-13', lastRev: 'abc1234', passedDate: '2026-10-13', passedRev: 'abc1234',
  nextDue: '2026-10-20', journey: 'opening', hotspot: 'src/game/move.ts', issues: [701],
});
const changes: Change[] = [
  { file: 'src/game/move.ts', commits: 5, lines: 400 },
  { file: 'src/components/share/SharePanel.tsx', commits: 4, lines: 300 },
  { file: 'src/game/move.test.ts', commits: 9, lines: 900 },
  { file: 'docs/DEVELOPMENT.md', commits: 9, lines: 900 },
];
const git = (overrides: Partial<GitInfo> = {}): GitInfo => ({
  head: 'fff0000', commitsSinceLast: 12, changes,
  changedFiles: ['src/components/share/SharePanel.tsx', 'src/game/move.ts', 'docs/DEVELOPMENT.md'], committed: {}, ...overrides,
});
const files = (entries: Record<string, string>, mtime = '2026-10-21'): ReadFile =>
  (path): FileRead | null => (path in entries ? { text: entries[path], mtime } : null);

describe('state line', () => {
  it('round-trips', () => {
    expect(parseState(formatState(passed))).toEqual(passed);
  });

  it('uses defaults for a bare line and rejects anything malformed', () => {
    expect(parseState('quality review:')).toEqual(state());
    for (const line of [
      'review: every=7d', 'quality review: every=0d', 'quality review: last=great@2026-10-13:abc1234',
      'quality review: next=tomorrow', 'quality review: save=eyJ', 'quality review: issues=701', 'quality review: budget=3',
    ]) expect(() => parseState(line), line).toThrow();
  });
});

describe('dry run: not due', () => {
  it('waits for the next-due day', () => {
    expect(decideDue(state({ ...passed, nextDue: '2026-10-29' }), '2026-10-22', 12)).toMatchObject({ due: false, reason: 'next due 2026-10-29' });
    const result = review({ state: state({ ...passed, nextDue: '2026-10-29' }), now: NOW, git: git(), tools: ALL_TOOLS, read: files({}) });
    expect(result.slice).toEqual([]);
    expect(formatReview(result)).toContain('not due');
  });

  it('prints only the due line and the flow-change line, not the signal dashboard', () => {
    const result = review({ state: state({ ...passed, nextDue: '2026-10-29' }), now: NOW, git: git(), tools: ALL_TOOLS, read: files({}) });
    expect(formatReview(result).split('\n')).toEqual([
      'quality review not due (next due 2026-10-29) today=2026-10-22 head=fff0000',
      'flow changes since last review (per-PR checks still apply now): sharing',
    ]);
    const quiet = review({ state: state({ ...passed, nextDue: '2026-10-29' }), now: NOW, git: git({ changedFiles: [] }), tools: ALL_TOOLS, read: files({}) });
    expect(formatReview(quiet).split('\n')).toHaveLength(1);
  });

  it('skips an idle week after a pass, but still reports flow changes', () => {
    expect(decideDue(passed, '2026-10-22', 0)).toMatchObject({ due: false, reason: 'idle: no commits since abc1234' });
    expect(touchedJourneys(git().changedFiles)).toEqual(['sharing']);
  });

  it('retries a non-pass even with no new commits', () => {
    expect(decideDue(state({ ...passed, lastStatus: 'blocked', nextDue: undefined, lastDate: '2026-10-20' }), '2026-10-22', 0).due).toBe(true);
  });
});

describe('dry run: due success', () => {
  it('picks the changed journey after the last one, the top hotspot, and a bounded plan', () => {
    const result = review({ state: passed, now: NOW, git: git(), tools: ALL_TOOLS, read: files({}) });
    expect(result.decision.due).toBe(true);
    expect(result.journey?.id).toBe('sharing');
    expect(result.slice.map((item) => [item.kind, item.id, item.planned])).toEqual([
      ['journey', 'sharing', true],
      // move.ts was last time's hotspot, so it rotates to the next one.
      ['hotspot', 'src/components/share/SharePanel.tsx', true],
    ]);
    expect(result.criteria).toBe(REVIEW_CRITERIA);
    const text = formatReview(result);
    expect(text).toContain('fresh task-only reviewer');
    expect(text).toContain('signals (existing evidence only, nothing rerun):');
  });

  it('records a pass: refreshes passed, rotates the slice and schedules one cadence out', () => {
    const next = recordRun(passed, { now: NOW, rev: 'fff0000', status: overallStatus(['pass', 'pass']), journey: 'sharing', hotspot: 'src/game/move.ts', issues: [702] });
    expect(next).toMatchObject({ lastStatus: 'pass', passedDate: '2026-10-22', passedRev: 'fff0000', nextDue: '2026-10-29', journey: 'sharing', issues: [701, 702] });
    expect(parseState(formatState(next))).toEqual(next);
  });

  it('rotates through every journey and starts over', () => {
    const order = JOURNEYS.map((journey) => journey.id);
    expect(pickJourney(null, []).id).toBe(order[0]);
    expect(pickJourney(state({ journey: order[order.length - 1] }), []).id).toBe(order[0]);
    expect(pickJourney(state({ journey: order[2] }), []).id).toBe(order[3]);
    expect(pickJourney(state({ journey: 'unknown' }), []).id).toBe(order[0]);
  });
});

describe('dry run: missing tools or budget exhausted', () => {
  it('blocks an agent-audit journey when claude or chromium is missing, and the record is not a pass', () => {
    const result = review({ state: passed, now: NOW, git: git(), tools: { claude: false, chromium: true }, read: files({}) });
    expect(result.slice[0]).toMatchObject({ planned: false, reason: 'missing tools: claude' });
    const status = overallStatus(result.slice.filter((item) => item.applicable).map((item) => (item.planned ? 'pass' : 'blocked')));
    expect(status).toBe('blocked');
    const next = recordRun(passed, { now: NOW, rev: 'fff0000', status, journey: 'sharing', hotspot: 'x.ts' });
    expect(next).toMatchObject({ lastStatus: 'blocked', passedDate: '2026-10-13', passedRev: 'abc1234', nextDue: '2026-10-23', journey: 'opening', hotspot: 'src/game/move.ts' });
  });

  it('does not need the agent tools for a fixture-based journey', () => {
    const plan = planSlice(JOURNEYS.find((journey) => journey.id === 'rankings')!, changes[0], DEFAULT_BUDGET, { claude: false, chromium: false });
    expect(plan.every((item) => item.planned)).toBe(true);
  });

  it('stops at each exhausted budget with the reason', () => {
    const sharing = JOURNEYS.find((journey) => journey.id === 'sharing')!;
    expect(planSlice(sharing, changes[0], { tasks: 1, minutes: 45, providerRuns: 2 }, ALL_TOOLS).map((item) => item.reason)).toEqual(['planned', 'task budget exhausted']);
    expect(planSlice(sharing, changes[0], { tasks: 3, minutes: 15, providerRuns: 2 }, ALL_TOOLS).map((item) => item.reason)).toEqual(['planned', 'time budget exhausted']);
    expect(planSlice(sharing, changes[0], { tasks: 3, minutes: 45, providerRuns: 0 }, ALL_TOOLS)[0].reason).toBe('provider-use budget exhausted');
  });

  it('fail, blocked and unrun never refresh the passed date', () => {
    for (const status of ['fail', 'blocked', 'unrun'] as const) {
      expect(recordRun(passed, { now: NOW, rev: 'fff0000', status, journey: 'sharing', hotspot: 'a.ts' })).toMatchObject({ passedDate: '2026-10-13', passedRev: 'abc1234' });
    }
    expect(recordRun(null, { now: NOW, rev: 'fff0000', status: 'blocked', journey: null, hotspot: null })).not.toHaveProperty('passedDate');
    expect(recordRun(passed, { now: NOW, rev: 'fff0000', status: 'fail', journey: 'sharing', hotspot: 'a.ts' })).toMatchObject({ lastStatus: 'fail', nextDue: '2026-10-29', journey: 'sharing' });
  });

  it('a partly unrun slice is not a pass', () => {
    expect(overallStatus(['pass', 'unrun'])).toBe('unrun');
    expect(overallStatus(['pass', 'fail', 'blocked'])).toBe('fail');
    expect(overallStatus([])).toBe('unrun');
  });
});

describe('hotspot', () => {
  it('ranks churn x size over code files only and rotates away from the previous pick', () => {
    expect(pickHotspot(changes)?.file).toBe('src/game/move.ts');
    expect(pickHotspot(changes, 'src/game/move.ts')?.file).toBe('src/components/share/SharePanel.tsx');
    expect(pickHotspot([changes[0]], 'src/game/move.ts')?.file).toBe('src/game/move.ts');
    expect(pickHotspot([changes[2], changes[3]])).toBeNull();
  });

  it('is not applicable, not blocked, after a docs-only change, so the journey result can still pass', () => {
    const plan = planSlice(JOURNEYS[0], null, DEFAULT_BUDGET, ALL_TOOLS);
    expect(plan[1]).toMatchObject({ id: null, planned: false, applicable: false });
    expect(plan[0]).toMatchObject({ planned: true, applicable: true });
    const docsOnly = review({ state: passed, now: NOW, git: git({ changes: [changes[3]], changedFiles: ['docs/DEVELOPMENT.md'] }), tools: ALL_TOOLS, read: files({}) });
    expect(formatReview(docsOnly)).toContain('n/a, not applicable');
    expect(formatReview(docsOnly)).not.toContain('BLOCKED');
    expect(overallStatus(docsOnly.slice.filter((item) => item.applicable).map(() => 'pass'))).toBe('pass');
    expect(planSlice(JOURNEYS[0], null, DEFAULT_BUDGET, { claude: false, chromium: true })[0]).toMatchObject({ planned: false, applicable: true });
  });
});

const PERF = 'test-results/performance/summary.json';
const BLOCKERS = 'config/release-blockers.json';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ON_MAIN: MainChecks = { isOnMain: () => true, existsOnMain: () => true };
const perf = (summary: object): Record<string, string> => ({ [PERF]: JSON.stringify(summary) });
const signalOf = (id: string, entries: Record<string, string>, committed: Record<string, string> = {}, main: MainChecks = ON_MAIN) =>
  collectSignals(files(entries), '2026-10-22', committed, main).find((signal) => signal.id === id)!;

/** A release-blockers entry that evaluateReleaseEligibility accepts as well formed. */
const blocker = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `B${n}`, canonicalIssue: 100 + n, title: 'Title', category: 'save_loss', classification: 'regression', affectedRevisions: ['abc'],
  scenario: 'Scenario', severityRationale: 'Why', owner: 'evanlin23', requiredEvidence: 'Evidence', disposition: 'unresolved', ...overrides,
});
const resolved = (n: number, overrides: Record<string, unknown> = {}) =>
  blocker(n, { disposition: 'resolved', resolution: { fixedInPr: 1, fixCommit: SHA_A, regressionTest: 'src/x.test.ts' }, ...overrides });

describe('evidence signals', () => {
  it('reports each signal as pass, fail, blocked or unrun with freshness, from existing files only', () => {
    const read = files({
      [BLOCKERS]: JSON.stringify({ version: 1, blockers: [blocker(1), resolved(2)] }),
      'test-results/agent-audit.json': JSON.stringify({ outcome: 'incomplete', date: '2026-09-01' }),
      'test-results/quality-evidence/ci-review.json': JSON.stringify({ status: 'fail', date: '2026-10-21', detail: 'PR 900 red\nci' }),
      'test-results/quality-evidence/branch-hygiene.json': '{not json',
      'test-results/quality-evidence/compatibility.json': JSON.stringify({ status: 'great' }),
    });
    const byId = Object.fromEntries(collectSignals(read, '2026-10-22', { [BLOCKERS]: '2026-10-21' }, ON_MAIN).map((signal) => [signal.id, signal]));
    expect(byId['release-blockers']).toMatchObject({ status: 'fail', fresh: true, date: '2026-10-21' });
    expect(byId['release-blockers'].detail).toContain('1 of 2 blockers open');
    expect(byId['agent-audit']).toMatchObject({ status: 'blocked', fresh: false, ageDays: 51 });
    expect(byId['agent-audit'].detail).toContain('not human evidence');
    expect(byId['ci-review']).toMatchObject({ status: 'fail', detail: 'PR 900 red ci' });
    expect(byId['branch-hygiene'].status).toBe('unrun');
    expect(byId.compatibility.status).toBe('unrun');
    expect(byId.capacity).toMatchObject({ status: 'unrun', date: null, fresh: false });
  });

  it('a file mtime is labelled unverified and never reads as fresh', () => {
    // files() stamps every file with mtime 2026-10-21, yesterday: it would be fresh if it counted.
    const ci = signalOf('ci-review', { 'test-results/quality-evidence/ci-review.json': JSON.stringify({ status: 'pass' }) });
    expect(ci).toMatchObject({ status: 'pass', date: null, ageDays: null, fresh: false, dateNote: 'unknown (mtime only: 2026-10-21)' });
    const audit = signalOf('agent-audit', { 'test-results/agent-audit.json': '{"outcome":"completed"}' });
    expect(audit).toMatchObject({ status: 'pass', date: null, fresh: false });
    const stated = signalOf('ci-review', { 'test-results/quality-evidence/ci-review.json': JSON.stringify({ status: 'pass', date: '2026-10-21' }) });
    expect(stated).toMatchObject({ fresh: true, dateNote: null });
    const text = formatReview(review({ state: null, now: NOW, git: git({ commitsSinceLast: null }), tools: ALL_TOOLS, read: files({ 'test-results/quality-evidence/ci-review.json': '{"status":"pass"}' }) }));
    expect(text).toContain('pass    ci-review [CLAUDE.md merge bar] date: unknown (mtime only: 2026-10-21)');
    expect(text).not.toMatch(/ci-review[^\n]*2026-10-21 /);
  });

  it('performance follows the reporter: only a passed, clean run of a commit on main with samples passes, and createdAt dates it', () => {
    const scenarios = [{ scenario: 'first-cold', recordedRuns: 3, passedRuns: 3 }];
    const run = { status: 'passed', createdAt: '2026-10-20T08:00:00.000Z', commit: SHA_A, trackedSourceDirty: false, scenarios };
    const pass = signalOf('performance', perf(run));
    expect(pass).toMatchObject({ status: 'pass', date: '2026-10-20', fresh: true });
    expect(pass.detail).toContain('commit aaaaaaa');
    for (const status of ['failed', 'timedout', 'interrupted']) {
      expect(signalOf('performance', perf({ ...run, status })).status, status).toBe('fail');
    }
    for (const empty of [{ scenarios: [] }, { scenarios: [{ scenario: 'first-cold', recordedRuns: 0 }] }, { scenarios: undefined }]) {
      expect(signalOf('performance', perf({ ...run, ...empty })).status).toBe('unrun');
    }
    // Measured with local edits, or with the flag missing: not a pass.
    for (const dirty of [{ trackedSourceDirty: true }, { trackedSourceDirty: undefined }]) {
      const dirtyRun = signalOf('performance', perf({ ...run, ...dirty }));
      expect(dirtyRun.status).toBe('unrun');
      expect(dirtyRun.detail).toContain('commit aaaaaaa');
      expect(dirtyRun.detail).toContain('tracked source was modified');
    }
    // A commit that is not an ancestor of origin/main (a branch or an unknown object) is not a pass either.
    const offMain = signalOf('performance', perf(run), {}, { isOnMain: (commit) => commit !== SHA_A, existsOnMain: () => true });
    expect(offMain.status).toBe('unrun');
    expect(offMain.detail).toContain('not on origin/main');
    expect(signalOf('performance', perf(run), {}, { isOnMain: () => false, existsOnMain: () => false }).status).toBe('unrun');
    expect(signalOf('performance', perf({ ...run, commit: undefined })).status).toBe('unrun');
    expect(signalOf('performance', perf({ ...run, commit: 'abc' })).status).toBe('unrun');
    // No createdAt: the file's checkout mtime is not a date for the run.
    expect(signalOf('performance', perf({ ...run, createdAt: undefined }))).toMatchObject({ date: null, fresh: false, dateNote: 'unknown (mtime only: 2026-10-21)' });
    // A bare parseable file used to read as a pass.
    expect(signalOf('performance', { [PERF]: '{"runs":[]}' }).status).toBe('unrun');
  });

  it('asks the injected git reader whether a commit and a path are on origin/main', () => {
    const calls: string[][] = [];
    const run: GitRun = (args) => {
      calls.push(args);
      if (args[0] === 'merge-base') { if (args[2] === SHA_A) return ''; throw new Error('not an ancestor'); }
      if (args[0] === 'cat-file') { if (args[2] === 'origin/main:src/x.test.ts') return ''; throw new Error('missing'); }
      throw new Error('unexpected');
    };
    const checks = mainChecks(run);
    expect([checks.isOnMain(SHA_A), checks.isOnMain(SHA_B), checks.isOnMain('abc'), checks.existsOnMain('src/x.test.ts'), checks.existsOnMain('src/y.ts')]).toEqual([true, false, false, true, false]);
    expect(calls[0]).toEqual(['merge-base', '--is-ancestor', SHA_A, 'origin/main']);
    expect(signalOf('performance', perf({ status: 'passed', commit: SHA_B, trackedSourceDirty: false, scenarios: [{ recordedRuns: 1 }] }), {}, checks).status).toBe('unrun');
  });

  it('release blockers: anything not a valid resolved entry is open, bad data fails closed, and the date is the last commit', () => {
    const record = (...blockers: unknown[]) => ({ [BLOCKERS]: JSON.stringify({ version: 1, blockers }) });
    expect(signalOf('release-blockers', record(resolved(1)), { [BLOCKERS]: '2026-10-21' })).toMatchObject({ status: 'pass', fresh: true });
    const exception = (expiresAt: string) => blocker(3, { disposition: 'mitigated_exception', mitigation: { expiresAt } });
    for (const open of [blocker(3), blocker(3, { disposition: 'corrective_release' }), exception('2026-11-01T00:00:00Z'), exception('2026-10-01T00:00:00Z'), blocker(3, { disposition: 'wip' }), {}, null]) {
      expect(signalOf('release-blockers', record(resolved(1), open)).status, JSON.stringify(open)).toBe('fail');
    }
    expect(signalOf('release-blockers', record(exception('2026-10-01T00:00:00Z'))).detail).toContain('1 expired exception');
    expect(signalOf('release-blockers', record(blocker(3, { disposition: 'wip' }))).detail).toContain('1 invalid');
    expect(signalOf('release-blockers', { [BLOCKERS]: '{"version":1,"blockers":{}}' }).status).toBe('fail');
    // The file's mtime (a checkout time) never makes it fresh; no commit date means no date.
    const undated = signalOf('release-blockers', record(resolved(1)));
    expect(undated).toMatchObject({ status: 'pass', date: null, fresh: false });
    expect(signalOf('release-blockers', record(resolved(1)), { [BLOCKERS]: '2026-08-01' })).toMatchObject({ fresh: false, ageDays: 82 });
    expect(undated.label).toBe('Release blockers record');
    expect(undated.detail).not.toContain('#70');
  });

  it('release blockers: a record that release-blockers.ts rejects never reads as pass', () => {
    const record = (version: unknown, ...blockers: unknown[]) => ({ [BLOCKERS]: JSON.stringify({ version, blockers }) });
    expect(signalOf('release-blockers', record(1, resolved(1))).status).toBe('pass');
    // Version: missing, other or mistyped is INVALID_RECORD there.
    for (const version of [undefined, 0, 2, '1']) {
      const result = signalOf('release-blockers', record(version, resolved(1)));
      expect(result.status, String(version)).toBe('fail');
      expect(result.detail).toContain('is not 1');
    }
    // Entries: the old test only looked at `disposition`, so a bare `resolved` used to pass.
    const bareResolved = { disposition: 'resolved' };
    const badEntries: Record<string, unknown> = {
      'bare resolved': bareResolved,
      'missing title': resolved(1, { title: '' }),
      'bad category': resolved(1, { category: 'cosmetic' }),
      'no affectedRevisions': resolved(1, { affectedRevisions: [] }),
      'no resolution': blocker(1, { disposition: 'resolved' }),
      'short fix commit': resolved(1, { resolution: { fixedInPr: 1, fixCommit: 'abc1234', regressionTest: 'src/x.test.ts' } }),
      'no regression test': resolved(1, { resolution: { fixedInPr: 1, fixCommit: SHA_A, regressionTest: ' ' } }),
      'no fixedInPr': resolved(1, { resolution: { fixCommit: SHA_A, regressionTest: 'src/x.test.ts' } }),
      'array entry': [],
    };
    for (const [name, entry] of Object.entries(badEntries)) {
      const result = signalOf('release-blockers', record(1, entry));
      expect(result.status, name).toBe('fail');
      expect(result.detail, name).toContain('1 invalid');
    }
    // Duplicate id or canonical issue.
    expect(signalOf('release-blockers', record(1, resolved(1), resolved(1))).status).toBe('fail');
    expect(signalOf('release-blockers', record(1, resolved(1), resolved(2, { canonicalIssue: 101 }))).status).toBe('fail');
    // A fix commit or regression test that is not on origin/main (or cannot be checked) is not resolved.
    expect(signalOf('release-blockers', record(1, resolved(1)), {}, { isOnMain: () => false, existsOnMain: () => true }).status).toBe('fail');
    expect(signalOf('release-blockers', record(1, resolved(1)), {}, { isOnMain: () => true, existsOnMain: () => false }).status).toBe('fail');
    expect(collectSignals(files(record(1, resolved(1))), '2026-10-22').find((signal) => signal.id === 'release-blockers')?.status).toBe('fail');
  });

  it('keeps physical device, screen reader and native sharing unrun unless a person recorded them', () => {
    const none = collectSignals(files({}), '2026-10-22');
    for (const id of ['physical-device', 'screen-reader', 'native-share']) expect(none.find((signal) => signal.id === id)?.status).toBe('unrun');
    const audited = collectSignals(files({ 'test-results/agent-audit.json': '{"outcome":"completed"}' }), '2026-10-22');
    expect(audited.find((signal) => signal.id === 'agent-audit')?.status).toBe('pass');
    expect(audited.find((signal) => signal.id === 'physical-device')?.status).toBe('unrun');
  });

  it('stays useful when only some evidence exists', () => {
    const result = review({ state: null, now: NOW, git: git({ commitsSinceLast: null }), tools: ALL_TOOLS, read: files({}) });
    expect(result.decision).toMatchObject({ due: true, reason: 'no review recorded' });
    expect(result.signals).toHaveLength(13);
    expect(result.signals.every((signal) => signal.status === 'unrun')).toBe(true);
  });
});

describe('state line size', () => {
  it('fits the ledger hook limit in the true worst case, with room for longer revisions', () => {
    const hook = readFileSync(new URL('../.claude/hooks/orient.mjs', import.meta.url), 'utf8');
    const limit = Number(/const MAX_LINE_CHARS = (\d+);/.exec(hook)?.[1]);
    expect(MAX_STATE_CHARS).toBeLessThanOrEqual(limit - 20);
    const longest = JOURNEYS.reduce((a, b) => (b.id.length > a.id.length ? b : a));
    // Worst case: blocked (so `passed=` is a separate field and the previous slice is kept), the longest
    // hotspot and journey, a three-digit non-default cadence, four four-digit issues, and 8-character
    // revisions (the fixed width is 7).
    const hotspot = 'a/'.repeat(MAX_HOTSPOT_CHARS / 2);
    const worst = recordRun(
      state({
        cadenceDays: 999, lastStatus: 'pass', lastDate: '2026-10-13', lastRev: 'abc12345', passedDate: '2026-10-13', passedRev: 'abc12345',
        journey: longest.id, hotspot,
      }),
      { now: NOW, rev: 'abcdef12', status: 'blocked', journey: null, hotspot: null, issues: [9996, 9997, 9998, 9999, 9995] },
    );
    expect(worst.issues).toHaveLength(MAX_STATE_ISSUES);
    const line = formatState(worst);
    expect(line).toContain('every=999d last=blocked@2026-10-22:abcdef12 passed=2026-10-13:abc12345');
    expect(line).toContain(`journey=${longest.id} hotspot=${hotspot} issues=#9997,#9998,#9999,#9995`);
    expect(line.length).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect(parseState(line)).toEqual(worst);
    // The same line with 9-character revisions is still under the limit.
    expect(line.length + 2).toBeLessThanOrEqual(MAX_STATE_CHARS);
    const kept = recordRun(null, { now: NOW, rev: 'abcdef1', status: 'pass', journey: 'sharing', hotspot: null, issues: [1, 2, 3, 4, 5, 6, 7] });
    expect(kept.issues).toEqual([4, 5, 6, 7]);
  });

  it('uses fixed 7-character revisions however long git would abbreviate', () => {
    expect(mainRev(() => 'abcdef0123456789abcdef0123456789abcdef01')).toBe('abcdef0');
    const args: string[][] = [];
    mainRev((a) => { args.push(a); return 'a'.repeat(40); });
    expect(args).toEqual([['rev-parse', 'origin/main']]);
  });

  it('omits default cadence, budget, next-due day and an unchanged passed pair, and restores them on parse', () => {
    expect(formatState(passed)).toBe('quality review: last=pass@2026-10-13:abc1234 journey=opening hotspot=src/game/move.ts issues=#701');
    expect(parseState(formatState(passed))).toEqual(passed);
    expect(formatState(state({ cadenceDays: 14, budget: { tasks: 1, minutes: 20, providerRuns: 0 } }))).toBe('quality review: every=14d budget=1t/20m/0p');
    expect(formatState(state())).toBe('quality review:');
    // A blocked review is retried tomorrow by default; a hand-set day is kept.
    const blocked = state({ lastStatus: 'blocked', lastDate: '2026-10-22', lastRev: 'abc1234', nextDue: '2026-10-23' });
    expect(formatState(blocked)).toBe('quality review: last=blocked@2026-10-22:abc1234');
    expect(parseState(formatState(blocked))).toEqual(blocked);
    expect(formatState({ ...blocked, nextDue: '2026-10-30' })).toContain('next=2026-10-30');
    expect(parseState('quality review: last=blocked@2026-10-22:abc1234 next=2026-10-30').nextDue).toBe('2026-10-30');
  });
});

describe('record date in a shallow clone', () => {
  const DAY_OF_RECORD = '2026-09-01';
  const reader = (options: { shallow: boolean; log?: string; boundary?: string | null }) => {
    const calls: string[][] = [];
    const run: GitRun = (args) => {
      calls.push(args);
      if (args[0] === 'log') return options.log ?? `${SHA_A} ${DAY_OF_RECORD}`;
      if (args.includes('--is-shallow-repository')) return options.shallow ? 'true' : 'false';
      if (args.includes('--git-path')) return '.git/shallow';
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    const read: string[] = [];
    const readText = (path: string): string => {
      read.push(path);
      if (options.boundary === null) throw new Error('ENOENT');
      return `${options.boundary ?? ''}\n`;
    };
    return { run, readText, calls, read };
  };

  it('returns the commit day of the last change to the record in a full clone', () => {
    const { run, readText, read } = reader({ shallow: false });
    expect(lastCommitDay(run, readText, BLOCKERS)).toBe(DAY_OF_RECORD);
    expect(read).toEqual([]);
  });

  it('records no date when git returns the shallow boundary commit: unknown, never fresh', () => {
    // The record did not change inside the fetched history, so `git log -1` hands back the boundary.
    const { run, readText, read, calls } = reader({ shallow: true, boundary: `${SHA_B}\n${SHA_A}` });
    expect(lastCommitDay(run, readText, BLOCKERS)).toBeUndefined();
    expect(read).toEqual(['.git/shallow']);
    expect(calls[0]).toEqual(['log', '-1', '--format=%H %cs', 'origin/main', '--', BLOCKERS]);
    // An undated record is never fresh, even though the log said 2026-09-01 (51 days old, so stale anyway) or a recent day.
    const recent = reader({ shallow: true, log: `${SHA_A} 2026-10-21`, boundary: SHA_A });
    const day = lastCommitDay(recent.run, recent.readText, BLOCKERS);
    expect(day).toBeUndefined();
    const committed: Record<string, string> = day ? { [BLOCKERS]: day } : {};
    const record = { [BLOCKERS]: JSON.stringify({ version: 1, blockers: [resolved(1)] }) };
    expect(signalOf('release-blockers', record, committed)).toMatchObject({ status: 'pass', date: null, ageDays: null, fresh: false });
  });

  it('keeps the date when the commit is a real change, not the boundary, in a shallow clone', () => {
    const { run, readText } = reader({ shallow: true, boundary: SHA_B });
    expect(lastCommitDay(run, readText, BLOCKERS)).toBe(DAY_OF_RECORD);
  });

  it('records no date when the shallow file cannot be read or git output is unusable', () => {
    expect(lastCommitDay(reader({ shallow: true, boundary: null }).run, reader({ shallow: true, boundary: null }).readText, BLOCKERS)).toBeUndefined();
    for (const log of ['', 'nonsense', `${SHA_A} yesterday`]) {
      const { run, readText } = reader({ shallow: false, log });
      expect(lastCommitDay(run, readText, BLOCKERS), log).toBeUndefined();
    }
    const failing: GitRun = () => { throw new Error('git failed'); };
    expect(lastCommitDay(failing, () => '', BLOCKERS)).toBeUndefined();
  });
});

describe('record arguments', () => {
  const FAKE_MAIN: GitRun = () => 'a'.repeat(40);
  const run = async (...args: string[]): Promise<{ code: number; errors: string[]; logs: string[] }> => {
    const errors: string[] = [];
    const logs: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((message: unknown) => { errors.push(String(message)); });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((message: unknown) => { logs.push(String(message)); });
    try { return { code: await main(['record', '--now=2026-10-22T09:00:00Z', ...args], FAKE_MAIN), errors, logs }; } finally { errorSpy.mockRestore(); logSpy.mockRestore(); }
  };

  it('rejects a journey or hotspot that parseState would refuse, before writing anything', async () => {
    for (const bad of ['--journey=home', '--journey=', '--hotspot=has space.ts', '--hotspot=a;b.ts', `--hotspot=${'x'.repeat(MAX_HOTSPOT_CHARS + 1)}`, '--hotspot=']) {
      const result = await run('--status=pass', bad);
      expect(result.code, bad).toBe(2);
      expect(result.errors[0], bad).toMatch(/^Bad --(journey|hotspot)/);
    }
  });

  it('prints the new line with a 7-character revision', async () => {
    const result = await run('--status=pass', '--journey=sharing');
    expect(result).toMatchObject({ code: 0, errors: [], logs: ['quality review: last=pass@2026-10-22:aaaaaaa journey=sharing'] });
  });

  it('refuses a line over the limit and names the optional fields that caused it, not --hotspot', async () => {
    // A blocked review keeps the previous slice, so the previous line's own fields decide the size.
    const long = 'quality review: every=999d budget=999t/9999m/999p last=pass@2026-10-13:abc1234 passed=2026-10-13:abc1234 '
      + `journey=collection-detail hotspot=${'a/'.repeat(MAX_HOTSPOT_CHARS / 2)} issues=#10001,#10002,#10003,#10004`;
    const result = await run(`--state=${long}`, '--status=blocked');
    expect(result.code).toBe(2);
    expect(result.logs).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/^State line is \d+ characters \(limit 215\)/);
    expect(Number(/is (\d+) characters/.exec(result.errors[0])?.[1])).toBeGreaterThan(MAX_STATE_CHARS);
    expect(result.errors[0]).toContain('every=999d budget=999t/9999m/999p passed=2026-10-13:abc1234');
    expect(result.errors[0]).not.toContain('--hotspot');
  });
});
