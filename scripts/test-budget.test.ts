import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createVitest, parseCLI, type TestModule, type Vitest } from 'vitest/node';
import TestBudgetReporter, { HANG_TIMEOUT_MS, TEST_BUDGET_REPORTER, runSummary } from './test-budget';

const fakeModule = (tests: number) => ({ children: { allTests: function* () { for (let i = 0; i < tests; i++) yield {}; } } }) as unknown as TestModule;

/** Runs the reporter over two modules (3 + 2 tests) that took `seconds`, and returns what it logged. */
const run = (seconds: number, { watch = false, npmScript = 'test' } = {}) => {
  const logged: { log: string[]; error: string[] } = { log: [], error: [] };
  const vitest = { config: { watch }, logger: { log: (line: string) => logged.log.push(line), error: (line: string) => logged.error.push(line) } } as unknown as Vitest;
  let clock = 1000;
  const reporter = new TestBudgetReporter({ now: () => clock, env: { npm_lifecycle_event: npmScript } });
  reporter.onInit(vitest);
  clock += seconds * 1000;
  reporter.onTestRunEnd([fakeModule(3), fakeModule(2)]);
  return logged;
};

describe('test run timing', () => {
  const exitCode = process.exitCode;
  afterEach(() => { process.exitCode = exitCode; });

  it('reports the time and test count of a run', () => {
    expect(runSummary({ seconds: 61.94, tests: 798, files: 81 })).toBe('Test time: 798 tests in 81 files took 61.9s (report-only)');
    expect(run(12)).toEqual({ log: ['Test time: 5 tests in 2 files took 12.0s (report-only)'], error: [] });
    expect(process.exitCode).toBe(exitCode);
  });

  it('never fails a run, however long it took', () => {
    // A loaded machine can take many times as long; the old 400 s budget failed such runs.
    expect(run(4000)).toEqual({ log: ['Test time: 5 tests in 2 files took 4000.0s (report-only)'], error: [] });
    expect(process.exitCode).toBe(exitCode);
  });

  it('leaves runs outside npm test, and watch runs, alone', () => {
    expect(run(20.5, { npmScript: '' })).toEqual({ log: [], error: [] });
    expect(run(20.5, { npmScript: 'test:browser' })).toEqual({ log: [], error: [] });
    expect(run(20.5, { watch: true })).toEqual({ log: [], error: [] });
    expect(process.exitCode).toBe(exitCode);
  });
});

describe('test run wiring', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const npmTest = (JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { scripts: { test: string } }).scripts.test;

  // Resolves Vitest's config for `npm test -- <flags>` the way the CLI does, without running tests.
  it.each([[], ['--reporter=dot'], ['--reporter=json', '--coverage.enabled=false']])('keeps the timing reporter and the hang timeout in npm test %j', async (...flags: string[]) => {
    const { options } = parseCLI([...npmTest.split(' '), ...flags]);
    const vitest = await createVitest('test', { ...options, root, watch: false });
    try {
      // createVitest loads the configured reporters, so a bad path would already have thrown.
      expect(vitest.config.reporters.filter((reporter) => Array.isArray(reporter) && reporter[0] === TEST_BUDGET_REPORTER)).toEqual([[TEST_BUDGET_REPORTER, {}]]);
      // A tighter --testTimeout in the script would turn load into failures again.
      expect([vitest.config.testTimeout, vitest.config.hookTimeout]).toEqual([HANG_TIMEOUT_MS, HANG_TIMEOUT_MS]);
    } finally { await vitest.close(); }
  });

  it('applies the hang timeout to targeted runs too', async () => {
    const vitest = await createVitest('test', { root, watch: false });
    try {
      expect([vitest.config.testTimeout, vitest.config.hookTimeout]).toEqual([HANG_TIMEOUT_MS, HANG_TIMEOUT_MS]);
    } finally { await vitest.close(); }
  });
});
