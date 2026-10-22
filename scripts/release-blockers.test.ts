import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BLOCKER_CATEGORIES,
  BLOCKER_CLASSIFICATIONS,
  RECORD_PATH,
  evaluateReleaseEligibility,
  parseArgs,
  recordDigest,
  runReleaseBlockerCheck,
  unauthorizedRecordChanges,
  type ReleaseBlocker,
  type ReleaseBlockersRecord,
  type ReleaseEligibilityOptions,
} from './release-blockers.ts';

const CANDIDATE = 'a'.repeat(40);
const FIX = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const APPROVED = 'd'.repeat(40);
const NOW = new Date('2026-10-22T12:00:00Z');
const REF = 'https://github.com/evanlin23/BrainrotTCG/issues/759#issuecomment-1';

const blocker = (over: Partial<ReleaseBlocker> = {}): ReleaseBlocker => ({
  id: 'RB-1',
  canonicalIssue: 1,
  title: 'Blank screen on start',
  category: 'startup_blank',
  classification: 'regression',
  affectedRevisions: ['main ' + OTHER],
  scenario: 'Open the site with a damaged save',
  severityRationale: 'App never renders',
  owner: 'evanlin23',
  requiredEvidence: 'a regression test passing on the final candidate',
  disposition: 'unresolved',
  ...over,
});
const record = (...blockers: ReleaseBlocker[]): ReleaseBlockersRecord => ({ version: 1, description: 'fixture', blockers });

/**
 * Candidate history holds FIX, APPROVED and itself; the candidate differs from APPROVED only in the
 * record; the tree holds only the listed test.
 */
const evaluate = (blockersRecord: unknown, over: Partial<ReleaseEligibilityOptions> = {}) =>
  evaluateReleaseEligibility({
    blockersRecord,
    candidateHead: CANDIDATE,
    currentTime: NOW,
    isAncestor: (a, d) => d === CANDIDATE && [FIX, APPROVED, CANDIDATE].includes(a),
    fileExistsAtCandidate: (p) => p === 'src/fix.test.ts',
    changedPathsBetween: (from) => (from === APPROVED ? [RECORD_PATH] : []),
    ...over,
  });

const resolved = (over: Partial<ReleaseBlocker['resolution']> = {}) =>
  blocker({ disposition: 'resolved', resolution: { fixedInPr: 10, fixCommit: FIX, regressionTest: 'src/fix.test.ts', ...over } });

const mitigated = (over: Partial<NonNullable<ReleaseBlocker['mitigation']>> = {}) =>
  blocker({
    disposition: 'mitigated_exception',
    mitigation: {
      scope: 'Only Safari 17 private windows',
      rationale: 'Storage is unavailable there and the app shows a notice',
      approvedBy: 'evanlin23',
      approvalRef: REF,
      approvedAt: '2026-10-20T00:00:00Z',
      mitigationEvidence: 'Browser smoke run linked in the issue',
      expiresAt: '2026-11-01T00:00:00Z',
      followUpIssue: 2,
      ...over,
    },
  });

const corrective = (over: Partial<NonNullable<ReleaseBlocker['correctiveRelease']>> = {}) =>
  blocker({
    id: 'RB-2',
    canonicalIssue: 2,
    disposition: 'corrective_release',
    correctiveRelease: {
      approvedCommit: APPROVED,
      nonWorseningEvidence: 'Full suite and browser smoke pass; only the import guard changed',
      compatibilityEvidence: 'Proof vectors and set locks unchanged',
      approvedBy: 'evanlin23',
      approvalRef: REF,
      approvedAt: '2026-10-21T00:00:00Z',
      ...over,
    },
  });

describe('evaluateReleaseEligibility', () => {
  it('approves a healthy record with no blockers', () => {
    const r = evaluate(record());
    expect(r).toMatchObject({ eligible: true, unresolvedBlockers: [], reasons: [] });
  });

  it('approves a blocker whose fix commit and regression test are in the candidate', () => {
    const r = evaluate(record(resolved()));
    expect(r).toMatchObject({ eligible: true, resolvedCount: 1, reasons: [] });
  });

  it('fails closed on an unresolved relevant blocker, naming what is needed', () => {
    const r = evaluate(record(blocker()));
    expect(r.eligible).toBe(false);
    expect(r.unresolvedBlockers).toEqual(['RB-1']);
    expect(r.reasons[0]).toMatch(/RB-1 \(#1: Blank screen on start\); needs a regression test/);
  });

  describe('stale or missing disposition', () => {
    it('rejects a resolution whose fix commit is not in the candidate', () => {
      const r = evaluate(record(resolved({ fixCommit: OTHER })));
      expect(r.eligible).toBe(false);
      expect(r.reasons[0]).toMatch(/not in candidate .*stale/);
    });

    it('rejects a short or unchecked SHA and a missing regression test', () => {
      expect(evaluate(record(resolved({ fixCommit: 'b'.repeat(7) }))).eligible).toBe(false);
      expect(evaluate(record(resolved({ regressionTest: 'src/gone.test.ts' }))).reasons[0]).toMatch(/not present/);
    });

    it('rejects a resolution when the candidate history cannot be checked', () => {
      expect(evaluate(record(resolved()), { isAncestor: undefined }).eligible).toBe(false);
    });

    it('rejects a missing disposition or required field', () => {
      const { disposition: _d, ...noDisposition } = blocker();
      const { requiredEvidence: _e, ...noEvidence } = blocker();
      expect(evaluate({ version: 1, blockers: [noDisposition] }).reasons[0]).toMatch(/disposition/);
      expect(evaluate({ version: 1, blockers: [noEvidence] }).reasons[0]).toMatch(/requiredEvidence/);
    });

    it('rejects a category outside the narrow definition', () => {
      const r = evaluate(record(blocker({ category: 'data_integrity' as never })));
      expect(r.eligible).toBe(false);
      expect(r.reasons[0]).toMatch(/category/);
    });

    it('fails closed when the candidate identity is unknown', () => {
      expect(evaluate(record(), { candidateHead: undefined }).unresolvedBlockers).toEqual(['UNKNOWN_CANDIDATE']);
      expect(evaluate(record(), { candidateHead: 'main' }).eligible).toBe(false);
    });

    it('fails closed when the record is missing, malformed or a different version', () => {
      for (const bad of [undefined, null, {}, { version: 1, blockers: 'none' }, { version: 2, blockers: [] }]) {
        expect(evaluate(bad).eligible).toBe(false);
      }
    });

    it('rejects duplicate entries for the same issue', () => {
      expect(evaluate(record(resolved(), resolved({}))).eligible).toBe(false);
    });
  });

  describe('mitigated exceptions', () => {
    it('allows an active, specifically approved exception', () => {
      const r = evaluate(record(mitigated()));
      expect(r).toMatchObject({ eligible: true, activeExceptions: ['RB-1'] });
    });

    it('fails closed once the exception has expired', () => {
      const r = evaluate(record(mitigated({ expiresAt: '2026-10-22T00:00:00Z' })));
      expect(r.eligible).toBe(false);
      expect(r.reasons[0]).toMatch(/expired/);
    });

    it('rejects an exception missing scope, rationale or evidence', () => {
      for (const f of ['scope', 'rationale', 'mitigationEvidence'] as const) {
        expect(evaluate(record(mitigated({ [f]: '' }))).eligible).toBe(false);
      }
    });

    it('rejects an exception longer than the renewal window', () => {
      expect(evaluate(record(mitigated({ expiresAt: '2027-01-01T00:00:00Z' }))).reasons[0]).toMatch(/more than 30 days/);
    });
  });

  describe('unauthorized approval', () => {
    it('rejects an approval from a login that is not the owner', () => {
      const r = evaluate(record(mitigated({ approvedBy: 'drive-by-contributor' })));
      expect(r.eligible).toBe(false);
      expect(r.reasons[0]).toMatch(/not a trusted approver/);
    });

    it('rejects an owner approval that does not link the specific decision', () => {
      expect(evaluate(record(mitigated({ approvalRef: 'owner approved all work' }))).eligible).toBe(false);
      expect(evaluate(record(corrective({ approvalRef: 'https://example.com/x' })), { correctiveTargetIssue: 2 }).eligible).toBe(false);
    });
  });

  describe('bounded corrective release', () => {
    it('lets the approved corrective candidate ship while other blockers stay tracked', () => {
      const r = evaluate(record(blocker(), corrective()), { correctiveTargetIssue: 2 });
      expect(r).toMatchObject({ eligible: true, correctiveRelease: 'RB-2', reasons: [] });
      expect(r.unresolvedBlockers).toEqual(['RB-1']);
    });

    it('rejects a corrective target with no approved entry for that issue', () => {
      const r = evaluate(record(blocker()), { correctiveTargetIssue: 2 });
      expect(r.eligible).toBe(false);
      expect(r.reasons.join('\n')).toMatch(/no corrective-release entry for that issue/);
      expect(r.reasons.join('\n')).toMatch(/Unresolved release blocker RB-1/);
    });

    it('rejects a target whose entry is merely unresolved', () => {
      expect(evaluate(record(blocker({ id: 'RB-2', canonicalIssue: 2 })), { correctiveTargetIssue: 2 }).eligible).toBe(false);
    });

    it('accepts the approved commit itself as the candidate', () => {
      expect(evaluate(record(corrective({ approvedCommit: CANDIDATE })), { correctiveTargetIssue: 2 }).eligible).toBe(true);
    });

    it('rejects an approval for a commit outside the candidate history', () => {
      const r = evaluate(record(blocker(), corrective({ approvedCommit: OTHER })), { correctiveTargetIssue: 2 });
      expect(r.eligible).toBe(false);
      expect(r.reasons[0]).toMatch(/not in candidate .*approval is stale/);
    });

    it('rejects a candidate that changes more than the record after the approved commit', () => {
      const r = evaluate(record(blocker(), corrective()), {
        correctiveTargetIssue: 2,
        changedPathsBetween: () => [RECORD_PATH, 'src/main.tsx'],
      });
      expect(r.eligible).toBe(false);
      expect(r.reasons[0]).toMatch(/changes src\/main\.tsx after approved commit .*stale/);
    });

    it('fails closed when the changes since approval cannot be checked', () => {
      expect(evaluate(record(corrective()), { correctiveTargetIssue: 2, changedPathsBetween: () => undefined }).eligible).toBe(false);
      expect(evaluate(record(corrective()), { correctiveTargetIssue: 2, changedPathsBetween: undefined }).eligible).toBe(false);
      expect(evaluate(record(corrective({ approvedCommit: 'd'.repeat(7) })), { correctiveTargetIssue: 2 }).eligible).toBe(false);
    });

    it('rejects a corrective entry without non-worsening or compatibility evidence', () => {
      for (const f of ['nonWorseningEvidence', 'compatibilityEvidence'] as const) {
        expect(evaluate(record(blocker(), corrective({ [f]: '' })), { correctiveTargetIssue: 2 }).eligible).toBe(false);
      }
    });

    it('blocks an ordinary candidate while a corrective-release entry is pending', () => {
      expect(evaluate(record(corrective())).eligible).toBe(false);
    });
  });
});

describe('unauthorizedRecordChanges', () => {
  it('flags dropping an unresolved blocker or rewriting its identity', () => {
    expect(unauthorizedRecordChanges(record(blocker()), record())).toHaveLength(1);
    expect(unauthorizedRecordChanges(record(blocker()), record(blocker({ canonicalIssue: 3 })))).toHaveLength(1);
  });

  it('allows pruning a resolved entry and adding new blockers', () => {
    expect(unauthorizedRecordChanges(record(resolved()), record(blocker({ id: 'RB-9', canonicalIssue: 9 })))).toEqual([]);
  });
});

describe('repository record', () => {
  const raw = readFileSync(new URL('../config/release-blockers.json', import.meta.url), 'utf8');
  const repo = JSON.parse(raw) as ReleaseBlockersRecord;

  it('uses only narrow categories, known classifications and full evidence fields', () => {
    for (const b of repo.blockers) {
      expect(BLOCKER_CATEGORIES).toContain(b.category);
      expect(BLOCKER_CLASSIFICATIONS).toContain(b.classification);
      expect(b.affectedRevisions.length).toBeGreaterThan(0);
      expect(b.requiredEvidence).not.toBe('');
    }
  });

  // Only shape is asserted here: pruning resolved entries or a healthy record must not fail checks.
  it('parses as a well-formed record', () => {
    const r = evaluate(repo);
    expect(r.reasons.join('\n')).not.toMatch(/malformed|is not 1|not an object|missing or has invalid|duplicates/);
  });

  it('digests the exact record bytes', () => {
    expect(recordDigest(raw)).toMatch(/^[0-9a-f]{64}$/);
    expect(recordDigest(raw + ' ')).not.toBe(recordDigest(raw));
  });
});

describe('parseArgs', () => {
  it('reads the candidate, base and corrective target', () => {
    expect(parseArgs(['--candidate', 'HEAD', '--base', 'origin/main', '--corrective-target', '668'])).toEqual({
      candidate: 'HEAD',
      base: 'origin/main',
      correctiveTarget: 668,
    });
    expect(() => parseArgs(['--bypass'])).toThrow(/Unknown argument/);
  });
});

/** Runs the real CLI path in a scratch repository: local git only, identity set in that repo. */
describe('release-blockers CLI', () => {
  let repo: string;
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), body);
  };
  const commit = (msg: string) => {
    sh('add', '-A');
    sh('commit', '-q', '-m', msg);
    return sh('rev-parse', 'HEAD');
  };
  const writeRecord = (...blockers: ReleaseBlocker[]) => write(RECORD_PATH, JSON.stringify(record(...blockers), null, 2));
  const run = (...argv: string[]) => runReleaseBlockerCheck(argv, repo, NOW);
  const commits: Record<string, string> = {};

  beforeAll(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'release-blockers-test-'));
    sh('init', '-q', '-b', 'main');
    sh('config', 'user.name', 'Release Blocker Test');
    sh('config', 'user.email', 'release-blocker-test@example.invalid');
    sh('config', 'commit.gpgsign', 'false');
    write('README.md', 'scratch\n');
    commits.noRecord = commit('before the record');
    write('src/app.ts', 'export const broken = true;\n');
    writeRecord(blocker(), blocker({ id: 'RB-2', canonicalIssue: 2 }));
    commits.recorded = commit('record two unresolved blockers');
    write('src/app.ts', 'export const broken = false;\n');
    commits.fix = commit('corrective fix for #2');
    writeRecord(blocker(), corrective({ approvedCommit: commits.fix }));
    commits.approved = commit('record the corrective approval');
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('lets the approved corrective release pass from its own tree', () => {
    const r = run('--candidate', 'HEAD', '--corrective-target', '2', '--base', commits.recorded);
    expect(r.stderr).toEqual([]);
    expect(r).toMatchObject({ code: 0 });
    expect(r.stdout.join('\n')).toMatch(/corrective release for RB-2, 1 still tracked/);
  });

  it('blocks the same candidate without the corrective declaration', () => {
    expect(run('--candidate', 'HEAD').code).toBe(1);
  });

  it('makes the approval stale once code changes after the approved commit', () => {
    sh('checkout', '-q', '-b', 'later', commits.approved);
    write('src/app.ts', 'export const broken = "maybe";\n');
    commit('unreviewed change');
    const r = run('--candidate', 'HEAD', '--corrective-target', '2');
    sh('checkout', '-q', 'main');
    expect(r.code).toBe(1);
    expect(r.stderr.join('\n')).toMatch(/changes src\/app\.ts after approved commit .*stale/);
  });

  it('fails closed when --base does not resolve', () => {
    const r = run('--candidate', 'HEAD', '--corrective-target', '2', '--base', 'origin/main');
    expect(r.code).toBe(1);
    expect(r.stderr.join('\n')).toMatch(/--base origin\/main does not resolve to a commit/);
  });

  it('skips the tamper check only for a real base that predates the record', () => {
    expect(run('--candidate', 'HEAD', '--corrective-target', '2', '--base', commits.noRecord).code).toBe(0);
  });

  it('reports dropping an unresolved blocker against the base', () => {
    sh('checkout', '-q', '-b', 'drop', commits.recorded);
    writeRecord(blocker({ id: 'RB-2', canonicalIssue: 2 }));
    commit('drop RB-1');
    const r = run('--candidate', 'HEAD', '--base', commits.recorded);
    sh('checkout', '-q', 'main');
    expect(r.code).toBe(1);
    expect(r.stderr.join('\n')).toMatch(/RB-1 was removed while unresolved/);
  });
});
