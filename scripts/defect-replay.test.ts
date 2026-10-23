// The replay's judgement and corpus, offline. The replay itself (real Vitest runs in a disposable
// worktree, about 40 s) runs by hand: docs/DEVELOPMENT.md, Escaped-defect replay.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CASES, classify, EVIDENCE_PATH, META, summarize, type CaseResult, type Run } from './defect-replay';
import { collectSignals, NO_MAIN_CHECKS } from './quality-review';

const TEST = { file: 'src/x.test.ts', name: 'x guards the thing' };
const C = { test: TEST, reason: /expected 'bad' to be 'good'/ };

/** A Vitest JSON report for one file, shaped as `--reporter=json` writes it. */
const run = (assertions: { fullName?: string; status: string; failureMessages?: string[] }[], exit: number | null = 0, message = ''): Run => ({
  exit,
  report: {
    testResults: [{
      name: `/tmp/defect-replay-1/tree/${TEST.file}`,
      status: assertions.some((a) => a.status === 'failed') || message ? 'failed' : 'passed',
      message,
      assertionResults: assertions.map((a) => ({ fullName: a.fullName ?? TEST.name, status: a.status, failureMessages: a.failureMessages ?? [] })),
    }],
  },
});
const healthy = run([{ status: 'passed' }]);
const failing = (message: string) => run([{ status: 'failed', failureMessages: [message] }], 1);

describe('classify', () => {
  it('validates only a healthy pass plus a faulty failure for the stated reason', () => {
    expect(classify(C, healthy, failing("AssertionError: expected 'bad' to be 'good'\n at x"), null)).toEqual({
      verdict: 'validated', detail: "AssertionError: expected 'bad' to be 'good'",
    });
  });

  it('calls a faulty variant that still passes ineffective: a vacuous test or a mock that hides the defect', () => {
    expect(classify(C, healthy, healthy, null).verdict).toBe('ineffective');
  });

  it.each<[string, Run, Run | null, string | null, RegExp]>([
    ['no healthy report', { exit: 1, report: null }, null, null, /healthy run wrote no report/],
    ['file not discovered', { exit: 1, report: { testResults: [] } }, null, null, /test file not discovered/],
    ['test not discovered', run([{ fullName: 'x something else', status: 'passed' }]), null, null, /^test not discovered/],
    ['skipped control', run([{ status: 'skipped' }]), null, null, /healthy control is skipped/],
    ['todo control', run([{ status: 'todo' }]), null, null, /healthy control is todo/],
    ['failing control', failing('boom'), null, null, /healthy control is failed/],
    ['unclean healthy run', run([{ status: 'passed' }], 1), null, null, /not clean/],
    ['stale reversion', healthy, null, 'src/x.ts has the fixed code 0 times, not once', /did not apply: .*0 times/],
    ['no faulty report', healthy, { exit: 1, report: null }, null, /faulty run wrote no report/],
    ['load error', healthy, run([], 1, 'Transform failed with 1 error'), null, /did not load the test: Transform failed/],
    ['skipped faulty', healthy, run([{ status: 'skipped' }]), null, /faulty test is skipped/],
    ['unrelated failure', healthy, failing('TypeError: setup broke'), null, /another reason: TypeError: setup broke/],
  ])('is inconclusive on %s', (_, h, f, applied, why) => {
    const outcome = classify(C, h, f, applied);
    expect(outcome.verdict).toBe('inconclusive');
    expect(outcome.detail).toMatch(why);
  });

  it('strips colour codes and newlines from what it reports', () => {
    expect(classify(C, healthy, failing('\x1b[31mTypeError\x1b[39m:\n  nope'), null).detail).toBe('fails for another reason: TypeError: nope');
  });
});

describe('summarize', () => {
  const ok = (id: string): CaseResult => ({ id, verdict: 'validated', detail: '' });
  const meta = (verdict: CaseResult['verdict'], expected: CaseResult['verdict']): CaseResult => ({ id: 'meta', verdict, detail: '', expect: expected });
  const at = (results: CaseResult[]) => summarize(results, '2026-10-23', 'abcdef0123456789');

  it('passes only when every case is validated and every meta-case reached its verdict', () => {
    expect(at([ok('a'), ok('b'), meta('ineffective', 'ineffective')])).toEqual({ status: 'pass', date: '2026-10-23', detail: '2/2 validated at abcdef0; meta 1/1' });
  });

  it('fails on a defect the gate misses, even when everything else is validated', () => {
    expect(at([ok('a'), { id: 'b', verdict: 'ineffective', detail: '' }])).toMatchObject({ status: 'fail', detail: expect.stringContaining('missed: b') });
  });

  it('fails when a meta-case is judged wrongly: the harness itself is not trustworthy', () => {
    expect(at([ok('a'), meta('validated', 'inconclusive')])).toMatchObject({ status: 'fail', detail: expect.stringContaining('harness wrong: meta') });
  });

  it('is blocked, never a pass, while a case is inconclusive; with no cases it fails', () => {
    expect(at([ok('a'), { id: 'b', verdict: 'inconclusive', detail: '' }])).toMatchObject({ status: 'blocked', detail: expect.stringContaining('inconclusive: b') });
    expect(at([]).status).toBe('fail');
  });

  it('reaches the quality review as its defect-replay signal', () => {
    const summary = at([{ id: 'b', verdict: 'ineffective', detail: '' }]);
    const read = (p: string) => (p === EVIDENCE_PATH ? { text: JSON.stringify(summary), mtime: '2026-10-23' } : null);
    const signal = collectSignals(read, '2026-10-23', {}, NO_MAIN_CHECKS).find((s) => s.id === 'defect-replay');
    expect(signal).toMatchObject({ status: 'fail', date: '2026-10-23', fresh: true, detail: expect.stringContaining('missed: b') });
  });
});

describe('the corpus', () => {
  const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

  it('names real escaped defects with their fix, invariant and gate', () => {
    expect(CASES.map((c) => c.defect)).toEqual(['#694', '#647', '#660']);
    for (const c of CASES) {
      expect(c.fix).toMatch(/^[0-9a-f]{7} \(#\d+\)$/);
      expect(c.invariant.length).toBeGreaterThan(40);
      expect(c.gate).toContain('npm run check');
    }
    expect(new Set([...CASES, ...META].map((c) => c.id)).size).toBe(CASES.length + META.length);
  });

  // A refactor that moves the fixed code leaves the replay inconclusive; this says so in the normal checks.
  it.each([...CASES, ...META].map((c) => [c.id, c] as const))('%s still applies to the code and its owning test exists', (_, c) => {
    const code = source(c.fault.file);
    expect(code.split(c.fault.find).length - 1, `${c.fault.file} holds the fixed code once`).toBe(1);
    const tests = source(c.test.file);
    if (c.id !== 'meta-not-discovered') expect(tests).toContain(`${c.test.name.split(' ').slice(-6).join(' ')}', `);
  });
});
