import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BUDGET, JOURNEYS, MAX_HOTSPOT_CHARS, MAX_STATE_CHARS, MAX_STATE_ISSUES, REVIEW_CRITERIA, collectSignals, decideDue,
  formatReview, formatState, main, overallStatus, parseState, pickHotspot, pickJourney, planSlice, recordRun, review,
  touchedJourneys,
  type Change, type FileRead, type GitInfo, type ReadFile, type ReviewState, type Tools,
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
const perf = (summary: object): Record<string, string> => ({ [PERF]: JSON.stringify(summary) });
const signalOf = (id: string, entries: Record<string, string>, committed: Record<string, string> = {}) =>
  collectSignals(files(entries), '2026-10-22', committed).find((signal) => signal.id === id)!;

describe('evidence signals', () => {
  it('reports each signal as pass, fail, blocked or unrun with freshness, from existing files only', () => {
    const read = files({
      [BLOCKERS]: JSON.stringify({ blockers: [{ disposition: 'unresolved' }, { disposition: 'resolved' }] }),
      'test-results/agent-audit.json': JSON.stringify({ outcome: 'incomplete', date: '2026-09-01' }),
      'test-results/quality-evidence/ci-review.json': JSON.stringify({ status: 'fail', date: '2026-10-21', detail: 'PR 900 red\nci' }),
      'test-results/quality-evidence/branch-hygiene.json': '{not json',
      'test-results/quality-evidence/compatibility.json': JSON.stringify({ status: 'great' }),
    });
    const byId = Object.fromEntries(collectSignals(read, '2026-10-22', { [BLOCKERS]: '2026-10-21' }).map((signal) => [signal.id, signal]));
    expect(byId['release-blockers']).toMatchObject({ status: 'fail', fresh: true, date: '2026-10-21' });
    expect(byId['release-blockers'].detail).toContain('1 of 2 blockers open');
    expect(byId['agent-audit']).toMatchObject({ status: 'blocked', fresh: false, ageDays: 51 });
    expect(byId['agent-audit'].detail).toContain('not human evidence');
    expect(byId['ci-review']).toMatchObject({ status: 'fail', detail: 'PR 900 red ci' });
    expect(byId['branch-hygiene'].status).toBe('unrun');
    expect(byId.compatibility.status).toBe('unrun');
    expect(byId.capacity).toMatchObject({ status: 'unrun', date: null, fresh: false });
  });

  it('performance follows the reporter: only a passed run with samples passes, and createdAt dates it', () => {
    const scenarios = [{ scenario: 'first-cold', recordedRuns: 3, passedRuns: 3 }];
    expect(signalOf('performance', perf({ status: 'passed', createdAt: '2026-10-20T08:00:00.000Z', scenarios }))).toMatchObject({ status: 'pass', date: '2026-10-20', fresh: true });
    for (const status of ['failed', 'timedout', 'interrupted']) {
      expect(signalOf('performance', perf({ status, createdAt: '2026-10-20T08:00:00.000Z', scenarios })).status, status).toBe('fail');
    }
    for (const empty of [{ scenarios: [] }, { scenarios: [{ scenario: 'first-cold', recordedRuns: 0 }] }, {}]) {
      expect(signalOf('performance', perf({ status: 'passed', createdAt: '2026-10-20T08:00:00.000Z', ...empty })).status).toBe('unrun');
    }
    // No createdAt: the file's checkout mtime is not a date for the run.
    expect(signalOf('performance', perf({ status: 'passed', scenarios }))).toMatchObject({ date: null, fresh: false });
    // A bare parseable file used to read as a pass.
    expect(signalOf('performance', { [PERF]: '{"runs":[]}' }).status).toBe('unrun');
  });

  it('release blockers: anything not resolved is open, bad data fails closed, and the date is the last commit', () => {
    const record = (...blockers: unknown[]) => ({ [BLOCKERS]: JSON.stringify({ blockers }) });
    expect(signalOf('release-blockers', record({ disposition: 'resolved' }), { [BLOCKERS]: '2026-10-21' })).toMatchObject({ status: 'pass', fresh: true });
    const exception = (expiresAt: string) => ({ disposition: 'mitigated_exception', mitigation: { expiresAt } });
    for (const open of [{ disposition: 'unresolved' }, { disposition: 'corrective_release' }, exception('2026-11-01T00:00:00Z'), exception('2026-10-01T00:00:00Z'), { disposition: 'wip' }, {}, null]) {
      expect(signalOf('release-blockers', record({ disposition: 'resolved' }, open)).status, JSON.stringify(open)).toBe('fail');
    }
    expect(signalOf('release-blockers', record(exception('2026-10-01T00:00:00Z'))).detail).toContain('1 expired exception');
    expect(signalOf('release-blockers', record({ disposition: 'wip' })).detail).toContain('1 invalid');
    expect(signalOf('release-blockers', { [BLOCKERS]: '{"blockers":{}}' }).status).toBe('fail');
    // The file's mtime (a checkout time) never makes it fresh; no commit date means no date.
    const undated = signalOf('release-blockers', record({ disposition: 'resolved' }));
    expect(undated).toMatchObject({ status: 'pass', date: null, fresh: false });
    expect(signalOf('release-blockers', record({ disposition: 'resolved' }), { [BLOCKERS]: '2026-08-01' })).toMatchObject({ fresh: false, ageDays: 82 });
    expect(undated.label).toBe('Release blockers record');
    expect(undated.detail).not.toContain('#70');
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
    expect(result.signals).toHaveLength(12);
    expect(result.signals.every((signal) => signal.status === 'unrun')).toBe(true);
  });
});

describe('state line size', () => {
  it('stays well under the ledger hook truncation limit, even with every field set', () => {
    const hook = readFileSync(new URL('../.claude/hooks/orient.mjs', import.meta.url), 'utf8');
    const limit = Number(/const MAX_LINE_CHARS = (\d+);/.exec(hook)?.[1]);
    expect(MAX_STATE_CHARS).toBeLessThanOrEqual(limit - 20);
    const longest = JOURNEYS.reduce((a, b) => (b.id.length > a.id.length ? b : a));
    const full = state({
      lastStatus: 'fail', lastDate: '2026-10-22', lastRev: 'abcdef1', passedDate: '2026-10-13', passedRev: 'abc1234',
      nextDue: '2026-10-29', journey: longest.id, hotspot: 'a/'.repeat(MAX_HOTSPOT_CHARS / 2),
      issues: [1234, 2345, 3456, 4567, 5678, 6789].slice(-MAX_STATE_ISSUES),
    });
    expect(formatState(full).length).toBeLessThanOrEqual(MAX_STATE_CHARS);
    expect(parseState(formatState(full))).toEqual(full);
    const kept = recordRun(null, { now: NOW, rev: 'abcdef1', status: 'pass', journey: 'sharing', hotspot: null, issues: [1, 2, 3, 4, 5, 6, 7] });
    expect(kept.issues).toEqual([4, 5, 6, 7]);
  });

  it('omits default cadence, budget and an unchanged passed pair, and restores them on parse', () => {
    expect(formatState(passed)).toBe('quality review: last=pass@2026-10-13:abc1234 next=2026-10-20 journey=opening hotspot=src/game/move.ts issues=#701');
    expect(formatState(state({ cadenceDays: 14, budget: { tasks: 1, minutes: 20, providerRuns: 0 } }))).toBe('quality review: every=14d budget=1t/20m/0p');
    expect(formatState(state())).toBe('quality review:');
  });
});

describe('record arguments', () => {
  const run = async (...args: string[]): Promise<{ code: number; errors: string[] }> => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((message: unknown) => { errors.push(String(message)); });
    try { return { code: await main(['record', '--now=2026-10-22T09:00:00Z', ...args]), errors }; } finally { spy.mockRestore(); }
  };

  it('rejects a journey or hotspot that parseState would refuse, before writing anything', async () => {
    for (const bad of ['--journey=home', '--journey=', '--hotspot=has space.ts', '--hotspot=a;b.ts', `--hotspot=${'x'.repeat(MAX_HOTSPOT_CHARS + 1)}`, '--hotspot=']) {
      const result = await run('--status=pass', bad);
      expect(result.code, bad).toBe(2);
      expect(result.errors[0], bad).toMatch(/^Bad --(journey|hotspot)/);
    }
  });
});
