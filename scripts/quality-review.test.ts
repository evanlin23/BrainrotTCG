import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET, JOURNEYS, REVIEW_CRITERIA, collectSignals, decideDue, dispositionFor, formatReview, formatState,
  overallStatus, parseState, pickHotspot, pickJourney, planSlice, recordRun, review, touchedJourneys,
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
  changedFiles: ['src/components/share/SharePanel.tsx', 'src/game/move.ts', 'docs/DEVELOPMENT.md'], ...overrides,
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
    expect(formatReview(result)).toContain('fresh task-only reviewer');
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
    const status = overallStatus(result.slice.map((item) => (item.planned ? 'pass' : 'blocked')));
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

  it('is blocked, not passed, when nothing changed', () => {
    const plan = planSlice(JOURNEYS[0], null, DEFAULT_BUDGET, ALL_TOOLS);
    expect(plan[1]).toMatchObject({ id: null, planned: false, reason: 'nothing changed to review' });
  });
});

describe('evidence signals', () => {
  it('reports each signal as pass, fail, blocked or unrun with freshness, from existing files only', () => {
    const read = files({
      'config/release-blockers.json': JSON.stringify({ blockers: [{ disposition: 'unresolved' }, { disposition: 'resolved' }] }),
      'test-results/agent-audit.json': JSON.stringify({ outcome: 'incomplete', date: '2026-09-01' }),
      'test-results/performance/summary.json': '{"runs":[]}',
      'test-results/quality-evidence/ci-review.json': JSON.stringify({ status: 'fail', date: '2026-10-21', detail: 'PR 900 red\nci' }),
      'test-results/quality-evidence/branch-hygiene.json': '{not json',
      'test-results/quality-evidence/compatibility.json': JSON.stringify({ status: 'great' }),
    });
    const byId = Object.fromEntries(collectSignals(read, '2026-10-22').map((signal) => [signal.id, signal]));
    expect(byId['release-checks']).toMatchObject({ status: 'fail', detail: '1 unresolved blockers', fresh: true });
    expect(byId['agent-audit']).toMatchObject({ status: 'blocked', fresh: false, ageDays: 51 });
    expect(byId['agent-audit'].detail).toContain('not human evidence');
    expect(byId.performance).toMatchObject({ status: 'pass', detail: expect.stringContaining('no pass/fail budget') });
    expect(byId['ci-review']).toMatchObject({ status: 'fail', detail: 'PR 900 red ci' });
    expect(byId['branch-hygiene'].status).toBe('unrun');
    expect(byId.compatibility.status).toBe('unrun');
    expect(byId.capacity).toMatchObject({ status: 'unrun', date: null, fresh: false });
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

describe('findings', () => {
  it('known duplicate: attach evidence to the canonical issue, no new task', () => {
    expect(dispositionFor({ key: 'share-copy', reproduced: true, searched: true, canonicalIssue: 701 })).toEqual({ action: 'attach-evidence', target: 'comment the evidence on #701' });
  });

  it('new reproduced defect: one bounded task, never a recurring audit issue', () => {
    const result = dispositionFor({ key: 'x', reproduced: true, searched: true });
    expect(result.action).toBe('create-bounded-task');
    expect(result.target).toContain('not a recurring audit issue');
  });

  it('search first, and do not open anything for an unreproduced observation', () => {
    expect(dispositionFor({ key: 'x', reproduced: true, searched: false }).action).toBe('search-first');
    expect(dispositionFor({ key: 'x', reproduced: false, searched: true }).action).toBe('note-only');
  });
});
