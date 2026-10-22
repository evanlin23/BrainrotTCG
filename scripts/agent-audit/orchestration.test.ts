import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  compactLedger,
  createTaskBrief,
  formatStartupOutput,
  parseReviewerReport,
  projectState,
  STATE_BUDGET,
  VerificationCache,
} from './orchestration';

const scratch = mkdtempSync(join(tmpdir(), 'brainrot-orchestration-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('orchestration state projection & budget bounds', () => {
  it('formats normal compact state within budget with OK status and allows merge', () => {
    const content = [
      '# Run: Phase 1 queue, started 2026-10-21',
      'ledger issue: #387',
      'authority: owner authorized Claude to review open PRs and merge eligible PRs under CLAUDE.md bar',
      'holds:',
      '- #85 profile verification held',
      '- #490 profile verification held',
      'order: #717, #712, #714',
      'done: 21 merged prior to Oct 21',
      'needs owner: none',
      'current: #717',
    ].join('\n');

    const result = projectState(content);
    expect(result.status).toBe('ok');
    expect(result.allowsMerge).toBe(true);
    expect(result.holdsTracked).toBe(2);
    expect(result.linesShown).toBe(10);
    expect(result.truncatedLinesCount).toBe(0);
    expect(result.message).toContain('OK');
    expect(result.sourceIssue).toBe('#387');
  });

  it('bounds an oversized single line to maxLineChars with a truncation marker', () => {
    const hugeLine = 'done: merged PR #100 with massive log dump ' + 'x'.repeat(5000);
    const content = [
      '# Run: Test',
      'ledger issue: #387',
      'authority: allowed',
      'holds:',
      '- #85 held',
      hugeLine,
      'current: next task',
    ].join('\n');

    const result = projectState(content);
    expect(result.truncatedLinesCount).toBe(1);
    expect(result.projection).toContain('... [line truncated]');
    // The huge line in history does not invalidate authority/holds
    expect(result.status).toBe('non_blocking_overflow');
    expect(result.allowsMerge).toBe(true);
    // Line itself is bounded
    const projectedLines = result.projection.split('\n');
    const truncatedLine = projectedLines.find((l) => l.includes('[line truncated]'));
    expect(truncatedLine?.length).toBeLessThanOrEqual(STATE_BUDGET.maxLineChars + 30);
  });

  it('fails closed (CRITICAL OVERFLOW / merge forbidden) if a single huge line occurs inside authority or holds', () => {
    const hugeHold = '- #85 held with massive explanation ' + 'y'.repeat(5000);
    const content = [
      '# Run: Test',
      'ledger issue: #387',
      'authority: allowed',
      'holds:',
      hugeHold,
      'current: next task',
    ].join('\n');

    const result = projectState(content);
    expect(result.status).toBe('critical_overflow');
    expect(result.allowsMerge).toBe(false);
    expect(result.message).toContain('CRITICAL OVERFLOW');
    expect(result.message).toContain('hold line truncated');
    expect(result.message).toContain('MERGE/DELETE NOTHING');
  });

  it('fails closed (CRITICAL OVERFLOW / merge forbidden) if a hold is located past the truncation boundary', () => {
    const lines = [
      '# Run: Long state',
      'ledger issue: #387',
      'authority: allowed',
      'order: 1, 2, 3',
    ];
    // Fill lines up to 82 lines
    for (let i = 0; i < 80; i++) {
      lines.push(`done: item ${i}`);
    }
    // Hold is at line 85, past the 80-line boundary!
    lines.push('holds:');
    lines.push('- #999 critical blocking hold past line 80');

    const content = lines.join('\n');
    const result = projectState(content);

    expect(result.status).toBe('critical_overflow');
    expect(result.allowsMerge).toBe(false);
    expect(result.message).toContain('CRITICAL OVERFLOW');
    expect(result.message).toContain('hold(s) past display boundary');
    expect(result.message).toContain('MERGE/DELETE NOTHING');
    expect(result.projection).not.toContain('#999'); // Verify hold is indeed not visible in projection
  });

  it('fails closed if authority or holds sections are completely missing from a non-trivial file', () => {
    const lines = ['# Run: Broken state', 'ledger issue: #387', 'order: 1, 2, 3'];
    for (let i = 0; i < 10; i++) lines.push(`random notes ${i}`);
    const result = projectState(lines.join('\n'));

    expect(result.status).toBe('critical_overflow');
    expect(result.allowsMerge).toBe(false);
    expect(result.message).toContain('Authority and holds missing');
  });

  it('allows merge with non-blocking warning when only history/done exceeds budget but authority and holds are intact', () => {
    const lines = [
      '# Run: Long history',
      'ledger issue: #387',
      'authority: allowed under CLAUDE.md bar',
      'holds:',
      '- #85 held',
      '- #490 held',
      'order: next',
    ];
    // Add 100 lines of history
    for (let i = 0; i < 100; i++) {
      lines.push(`done: old PR #${i} merged commit abc${i}`);
    }

    const content = lines.join('\n');
    const result = projectState(content);

    expect(result.status).toBe('non_blocking_overflow');
    expect(result.allowsMerge).toBe(true);
    expect(result.message).toContain('WARNING: State truncated to fit budget');
    expect(result.message).toContain('Authority and holds intact');
    expect(result.linesShown).toBe(STATE_BUDGET.maxLines);
  });
});

describe('startup output formatting', () => {
  it('formats missing NOW.md state with clear instructions and merge/delete forbidden', () => {
    const output = formatStartupOutput({
      branch: 'main',
      commit: '2bf6074 Cut coordinator',
      stateContent: null,
    });

    expect(output).toContain('Branch: main at 2bf6074 Cut coordinator');
    expect(output).toContain('No .claude/state/NOW.md here. Only /work uses it');
    expect(output).toContain('Status: MISSING (merge/delete forbidden until loaded from ledger issue)');
  });

  it('formats valid compact state with branch, commit and status', () => {
    const content = [
      '# Run: Test',
      'ledger issue: #387',
      'authority: allowed',
      'holds:',
      '- #85 held',
      'order: 1',
    ].join('\n');

    const output = formatStartupOutput({
      branch: 'main',
      commit: '2bf6074',
      uncommitted: [' M package.json'],
      stateContent: content,
    });

    expect(output).toContain('Branch: main at 2bf6074');
    expect(output).toContain('Uncommitted:\n M package.json');
    expect(output).toContain('--- .claude/state/NOW.md (source: #387, git: 2bf6074) ---');
    expect(output).toContain('--- Status: OK');
  });
});

describe('safe compaction of #387', () => {
  it('compacts raw ledger into compact state preserving provenance, authority and ALL holds', () => {
    const rawLedger387 = 'historical text '.repeat(1000);
    const compacted = compactLedger(rawLedger387);

    const result = projectState(compacted);
    expect(result.status).toBe('ok');
    expect(result.allowsMerge).toBe(true);
    expect(result.linesShown).toBeLessThanOrEqual(40);
    expect(result.charsShown).toBeLessThanOrEqual(2500);

    // Verify all key holds are preserved
    expect(compacted).toContain('#85, #490');
    expect(compacted).toContain('Genesis cards stay (#22)');
    expect(compacted).toContain('No background music (#71)');
    expect(compacted).toContain('Free forever, no loot boxes');
    expect(compacted).toContain('Min-score floor untracked');
    expect(compacted).toContain('Branch deletion remains Claude-only (#710)');
    expect(compacted).toContain('ledger issue: #387');
  });
});

describe('verification cache', () => {
  it('caches passes by exact SHA and rejects earlier-head passes when SHA changes', () => {
    const cache = new VerificationCache();
    const headA = 'a1b2c3d';
    const headB = 'e4f5g6h';

    cache.record({ sha: headA, command: 'npm run check', status: 'pass' });
    expect(cache.hasValidPass(headA, 'npm run check')).toBe(true);

    // Head B has not been checked; must NOT reuse earlier-head pass
    expect(cache.hasValidPass(headB, 'npm run check')).toBe(false);

    // Different command on Head A
    expect(cache.hasValidPass(headA, 'npm test')).toBe(false);

    // Record failure on Head B
    cache.record({ sha: headB, command: 'npm run check', status: 'fail' });
    expect(cache.hasValidPass(headB, 'npm run check')).toBe(false);
  });
});

describe('small task briefs and independent review validation', () => {
  it('creates small structured task brief without large conversation or diff dumps', () => {
    const brief = createTaskBrief({
      issue: 717,
      outcome: 'Reduce Claude orchestration token overhead',
      acceptance: ['Establish small explicit budget', 'Bounded startup projection'],
      relevantPaths: ['.claude/hooks/orient.sh', '.claude/skills/work/SKILL.md'],
      prerequisites: ['PR #689 reviewed'],
      riskTier: 'high',
      modelTier: 'opus',
      head: '2bf6074',
      requiredEvidence: ['npm run check passes', 'orient tests pass'],
      unresolvedFindings: ['Ensure holds past boundary fail closed'],
    });

    expect(brief.split('\n').length).toBeLessThanOrEqual(25);
    expect(brief.length).toBeLessThan(1200);
    expect(brief).toContain('Issue #717');
    expect(brief).toContain('model: opus');
    expect(brief).toContain('unresolved findings to address:');
  });

  it('accepts clean reviewer approval on matching head', () => {
    const report = [
      'verdict: approve',
      'head: 2bf6074',
      'findings:',
      '- [minor] .claude/hooks/orient.sh:10: comment wording',
      'not checked: full actionlint in sandbox',
    ].join('\n');

    const result = parseReviewerReport(report, '2bf6074');
    expect(result.verdict).toBe('approve');
    expect(result.allowsMerge).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('minor');
  });

  it('rejects merge if reviewer finds a blocking defect', () => {
    const report = [
      'verdict: changes-needed',
      'head: 2bf6074',
      'findings:',
      '- [blocking] .claude/hooks/orient.sh:14: hold past boundary was truncated without error',
      'not checked: none',
    ].join('\n');

    const result = parseReviewerReport(report, '2bf6074');
    expect(result.allowsMerge).toBe(false);
    expect(result.reason).toContain('changes-needed');
  });

  it('rejects merge if reviewer approved an older/stale head SHA', () => {
    const report = [
      'verdict: approve',
      'head: 1111111',
      'findings:',
      'not checked: none',
    ].join('\n');

    const currentCandidateHead = '2bf6074';
    const result = parseReviewerReport(report, currentCandidateHead);
    expect(result.allowsMerge).toBe(false);
    expect(result.reason).toContain('does not match current candidate head');
  });
});

describe('orient hook pipe execution test', () => {
  it('runs .claude/hooks/orient.sh with a huge single line fixture and verifies output is bounded', () => {
    const testDir = mkdtempSync(join(scratch, 'orient-exec-'));
    const stateDir = join(testDir, '.claude', 'state');
    mkdirSync(stateDir, { recursive: true });

    const hugeLine = 'done: oversized ' + 'z'.repeat(4000);
    const content = [
      '# Run: Test Pipe',
      'ledger issue: #387',
      'authority: allowed',
      'holds:',
      '- #85 held',
      hugeLine,
      'current: ready',
    ].join('\n');
    writeFileSync(join(stateDir, 'NOW.md'), content);

    const scriptPath = join(process.cwd(), '.claude', 'hooks', 'orient.sh');
    const result = spawnSync('bash', [scriptPath], {
      cwd: testDir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: testDir },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--- .claude/state/NOW.md');
    expect(result.stdout).toContain('... [line truncated]');
    expect(result.stdout).toContain('WARNING: State truncated to fit budget');
    expect(result.stdout).not.toContain('z'.repeat(300)); // The full 4000 'z's are NOT printed
  });

  it('runs .claude/hooks/orient.sh with hold past truncation boundary and reports critical overflow', () => {
    const testDir = mkdtempSync(join(scratch, 'orient-overflow-'));
    const stateDir = join(testDir, '.claude', 'state');
    mkdirSync(stateDir, { recursive: true });

    const lines = [
      '# Run: Test Overflow',
      'ledger issue: #387',
      'authority: allowed',
    ];
    for (let i = 0; i < 82; i++) lines.push(`done: item ${i}`);
    lines.push('holds:');
    lines.push('- #999 hold past line 80');
    writeFileSync(join(stateDir, 'NOW.md'), lines.join('\n'));

    const scriptPath = join(process.cwd(), '.claude', 'hooks', 'orient.sh');
    const result = spawnSync('bash', [scriptPath], {
      cwd: testDir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: testDir },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CRITICAL OVERFLOW');
    expect(result.stdout).toContain('MERGE/DELETE NOTHING');
    expect(result.stdout).not.toContain('#999 hold past line 80');
  });
});
