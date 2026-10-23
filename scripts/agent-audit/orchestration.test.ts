import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
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
    expect(result.message).toContain('MERGE/CLOSE/DELETE NOTHING');
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
    expect(result.message).toContain('MERGE/CLOSE/DELETE NOTHING');
    expect(result.projection).not.toContain('#999'); // Verify hold is indeed not visible in projection
  });

  it('counts every non-blank line in the holds block as a hold, including text with a colon', () => {
    const content = [
      '# Run: Colon holds',
      'ledger issue: #387',
      'authority: allowed',
      'holds:',
      '- Min-score floor untracked: blocker before wiring any min-score board',
      'Profile verification: deferred by owner',
      '#85 held',
      '',
      '- Branch deletion remains Claude-only (#710)',
      'order: #717',
    ].join('\n');

    const result = projectState(content);
    expect(result.holdsTracked).toBe(4);
    expect(result.status).toBe('ok');
  });

  it('fails closed when a hold containing a colon sits at the boundary and later holds are cut off', () => {
    const lines = ['# Run: Long state', 'ledger issue: #387', 'authority: allowed'];
    for (let i = 0; i < 75; i++) lines.push(`order: item ${i}`);
    lines.push('holds:');
    lines.push('- Min-score floor untracked: blocker before wiring any min-score board');
    lines.push('- New sets: owner approval required');
    lines.push('- Branch deletion remains Claude-only (#710)');

    const result = projectState(lines.join('\n'));
    expect(result.linesShown).toBe(STATE_BUDGET.maxLines);
    expect(result.status).toBe('critical_overflow');
    expect(result.allowsMerge).toBe(false);
    expect(result.message).toContain('2 hold(s) past display boundary');
  });

  it('fails closed when the holds header itself is past the boundary, even with no holds', () => {
    const lines = ['# Run: Long state', 'ledger issue: #387', 'authority: allowed'];
    for (let i = 0; i < 80; i++) lines.push(`order: item ${i}`);
    lines.push('holds: none');

    const result = projectState(lines.join('\n'));
    expect(result.status).toBe('critical_overflow');
    expect(result.allowsMerge).toBe(false);
    expect(result.message).toContain('holds block past display boundary');
  });

  it('fails closed when the holds section is missing even if authority is present', () => {
    const content = ['# Run: No holds', 'ledger issue: #387', 'authority: allowed', 'order: #717'].join('\n');
    const result = projectState(content);
    expect(result.status).toBe('critical_overflow');
    expect(result.allowsMerge).toBe(false);
    expect(result.message).toContain('holds: section missing');
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
  it('formats missing NOW.md state with clear instructions and merge/close/delete forbidden', () => {
    const output = formatStartupOutput({
      branch: 'main',
      commit: '2bf6074 Cut coordinator',
      stateContent: null,
    });

    expect(output).toContain('Branch: main at 2bf6074 Cut coordinator');
    expect(output).toContain('No .claude/state/NOW.md here. Only /work uses it');
    expect(output).toContain('Status: MISSING (merge/close/delete forbidden until loaded from ledger issue)');
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

// Excerpt of the "Claude work ledger" issue #387 working copy (2026-10-22), as mirrored to NOW.md.
const LEDGER_387_EXCERPT = [
  '# Run: Phase 1 completion (owner: "continue until done with phase 1", merge allowed), started 2026-10-22',
  'ledger issue: #387 (order/scope: #716)',
  'authority: #387 owner brief: whole Phase 1 queue, task cap lifted; review/fix/supersede PRs, implement',
  '  missing Phase 1 work, close dup/superseded/obsolete PRs w/ reason, merge eligible reviewed PRs one at',
  "  a time under CLAUDE.md bar. All design calls Claude's. Emulation counts as phone evidence (label it).",
  '  Not allowed: push to main, admin bypass, real-data tests/deploys, Phase 2 social publishing, backend,',
  '  set addition or set draft-flag removal. Owner-only: their accounts/settings/legal claims.',
  'holds: none of the #387 holds (#292 #377 #378 #375 #380/#381 #203 #188 #284/#290 #313) are open PRs.',
  '  #85/#490 deferred (whole-profile verification). Owner art/set/legal holds stand.',
  'order (#716 rows; PR -> issue; tier o=opus s=sonnet):',
  'R1: #904->#811 o, #905->#660/#659 o, #906->#693 o, #907->#652 o, #909->#621 o,',
  'needs owner: #358 TikTok 2FA (owner-only); #703/#704 real AT/mobile; #705/#706 staging access',
  '',
  '# Run: Phase 1 review sweep (historical), 2026-10-18',
  'holds (fix first, then merge):',
  '  #377 fix first, then merge',
  '  #378 fix first, then merge',
  'done: #899 #900 merged',
].join('\n');

// The /work quality review keeps one `quality review:` line (scripts/quality-review.ts) in the ledger.
const qualityReviewAfterHolds = [
  '# Run: Quality', 'ledger issue: #387', 'authority: allowed',
  'holds:', '  #85 held', 'quality review: every=7d last=pass@2026-10-20:abc1234 next=2026-10-27', 'current: idle',
].join('\n');

describe('quality review ledger line', () => {
  it('ends the holds block instead of becoming a hold', () => {
    const result = projectState(qualityReviewAfterHolds);
    expect(result.holdsTracked).toBe(1);
    expect(result.projection).toContain('quality review: every=7d');
  });
});

describe('#387 ledger snapshot', () => {
  it('tracks every line of its authority and holds blocks and fails closed when either is cut off', () => {
    const result = projectState(LEDGER_387_EXCERPT);
    expect(result.sourceIssue).toBe('#387');
    expect(result.holdsTracked).toBe(4);
    expect(result.status).toBe('ok');

    const cutHolds = projectState(LEDGER_387_EXCERPT, { maxLines: 8 });
    expect(cutHolds.allowsMerge).toBe(false);
    expect(cutHolds.message).toContain('3 hold(s) past display boundary');

    // The historical `holds (fix first, then merge):` block counts as holds too.
    const cutHistoricalHolds = projectState(LEDGER_387_EXCERPT, { maxLines: 15 });
    expect(cutHistoricalHolds.allowsMerge).toBe(false);
    expect(cutHistoricalHolds.message).toContain('2 hold(s) past display boundary');

    const cutHistoricalHeader = projectState(LEDGER_387_EXCERPT, { maxLines: 14 });
    expect(cutHistoricalHeader.allowsMerge).toBe(false);
    expect(cutHistoricalHeader.message).toContain('holds block past display boundary');

    const cutAuthority = projectState(LEDGER_387_EXCERPT, { maxLines: 5 });
    expect(cutAuthority.allowsMerge).toBe(false);
    expect(cutAuthority.message).toContain('authority past display boundary');
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
    expect(result.reason).toContain('blocking findings');
  });

  // The exact reply template from .claude/agents/reviewer.md.
  const templateReport = (verdict: string, head: string, findings: string[]) =>
    [
      `verdict: ${verdict}`,
      `head: ${head}`,
      'findings (most severe first, at most 5):',
      ...findings,
      'not checked: browser specs (CI covers them)',
    ].join('\n');

  it('parses the reviewer.md template and refuses an approve that carries a blocking finding', () => {
    const report = templateReport('approve', '2bf6074', [
      '- [blocking] .claude/hooks/orient.mjs:74: a hold with a colon ends the holds block',
      '- [minor] SKILL.md:65: wording',
    ]);
    const result = parseReviewerReport(report, '2bf6074abc');
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toEqual({
      severity: 'blocking',
      location: '.claude/hooks/orient.mjs:74',
      description: 'a hold with a colon ends the holds block',
    });
    expect(result.notChecked).toEqual(['browser specs (CI covers them)']);
    expect(result.allowsMerge).toBe(false);
    expect(result.reason).toContain('blocking findings');
  });

  it('allows a clean approve in the template format on a matching head', () => {
    const result = parseReviewerReport(templateReport('approve', '2bf6074', ['- [minor] a.ts:1: nit']), '2bf6074abc');
    expect(result.allowsMerge).toBe(true);
  });

  it('treats an unreadable finding bullet as blocking', () => {
    const result = parseReviewerReport(templateReport('approve', '2bf6074', ['- saves can be lost']), '2bf6074');
    expect(result.allowsMerge).toBe(false);
    expect(result.findings[0].severity).toBe('blocking');
  });

  it.each([
    ['a * bullet', '* [blocking] a.ts:1: x'],
    ['a numbered bullet', '1. [blocking] a.ts:1: x'],
    ['an unbulleted line', '[blocking] a.ts:1: x'],
    ['an unreadable unbulleted line', 'saves can be lost'],
  ])('refuses an approve whose findings carry %s', (_label, line) => {
    const result = parseReviewerReport(templateReport('approve', '2bf6074', [line]), '2bf6074');
    expect(result.allowsMerge).toBe(false);
    expect(result.findings[0].severity).toBe('blocking');
  });

  it('refuses an approve with a [blocking] tag outside the findings block', () => {
    const report = ['verdict: approve', 'head: 2bf6074', '[blocking] a.ts:1: x', 'findings:', 'none'].join('\n');
    const result = parseReviewerReport(report, '2bf6074');
    expect(result.allowsMerge).toBe(false);
  });

  it('reads `none` and non-dash minor bullets as mergeable', () => {
    expect(parseReviewerReport(templateReport('approve', '2bf6074', ['none']), '2bf6074').allowsMerge).toBe(true);
    const minor = parseReviewerReport(templateReport('approve', '2bf6074', ['* [minor] a.ts:1: nit']), '2bf6074');
    expect(minor.allowsMerge).toBe(true);
    expect(minor.findings[0].severity).toBe('minor');
  });

  it('refuses a head shorter than 7 hex characters even when it prefixes the candidate', () => {
    const result = parseReviewerReport(templateReport('approve', 'c', []), 'c143bbf');
    expect(result.head).toBe('');
    expect(result.allowsMerge).toBe(false);
    expect(result.reason).toContain('does not match');
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
    expect(result.stdout).toContain('MERGE/CLOSE/DELETE NOTHING');
    expect(result.stdout).not.toContain('#999 hold past line 80');
  });
});

function runHook(content: string, label: string): string {
  const testDir = mkdtempSync(join(scratch, `orient-${label}-`));
  const stateDir = join(testDir, '.claude', 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'NOW.md'), content);
  const result = spawnSync('bash', [join(process.cwd(), '.claude', 'hooks', 'orient.sh')], {
    cwd: testDir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: testDir },
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  return result.stdout;
}

describe('orient hook hold tracking (fail closed)', () => {
  const colonHoldsAtBoundary = (() => {
    const lines = ['# Run: Colon holds', 'ledger issue: #387', 'authority: allowed'];
    for (let i = 0; i < 75; i++) lines.push(`order: item ${i}`);
    lines.push('holds:');
    lines.push('- Min-score floor untracked: blocker before wiring any min-score board');
    lines.push('- New sets under src/content/sets/: owner approval required');
    lines.push('- Branch deletion remains Claude-only (#710)');
    return lines.join('\n');
  })();

  it('reports critical overflow, not a warning, when holds after a colon-bearing hold are cut off', () => {
    const stdout = runHook(colonHoldsAtBoundary, 'colon');
    expect(stdout).toContain('CRITICAL OVERFLOW');
    expect(stdout).toContain('2 hold(s) past display boundary');
    expect(stdout).toContain('MERGE/CLOSE/DELETE NOTHING');
    expect(stdout).not.toContain('Authority and holds intact');
    expect(stdout).not.toContain('Branch deletion remains Claude-only');
  });

  it('agrees with projectState on projection and status for every fixture', () => {
    const longHistory = ['# Run: History', 'ledger issue: #387', 'authority: allowed', 'holds:', '- #85 held'];
    for (let i = 0; i < 100; i++) longHistory.push(`done: old PR #${i}`);
    const fixtures: Record<string, string> = {
      colon: colonHoldsAtBoundary,
      ledger387: LEDGER_387_EXCERPT,
      history: longHistory.join('\n'),
      qualityReview: qualityReviewAfterHolds,
      noHolds: ['# Run: No holds', 'ledger issue: #387', 'authority: allowed', 'order: #717'].join('\n'),
      hugeHold: ['# Run: Huge', 'authority: allowed', 'holds:', '- #85: ' + 'y'.repeat(500)].join('\n'),
    };
    for (const [label, content] of Object.entries(fixtures)) {
      const stdout = runHook(content, `parity-${label}`);
      const projection = projectState(content);
      expect(stdout, label).toContain(`\n${projection.projection}\n--- Status: ${projection.message} ---`);
    }
  });
});
