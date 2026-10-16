import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createVitest, parseCLI, type TestModule, type Vitest } from 'vitest/node';
import TestBudgetReporter, { RUNTIME_BUDGET_SECONDS, TEST_BUDGET_REPORTER, checkRuntimeBudget } from './test-budget';

const fakeModule = (tests: number) => ({ children: { allTests: function* () { for (let i = 0; i < tests; i++) yield {}; } } }) as unknown as TestModule;

/** Runs the reporter over two modules (3 + 2 tests) that took `seconds`, and returns what it logged. */
const run = (seconds: number, budgetSeconds: number, { watch = false, npmScript = 'test' } = {}) => {
  const logged: { log: string[]; error: string[] } = { log: [], error: [] };
  const vitest = { config: { watch }, logger: { log: (line: string) => logged.log.push(line), error: (line: string) => logged.error.push(line) } } as unknown as Vitest;
  let clock = 1000;
  const reporter = new TestBudgetReporter({ budgetSeconds, now: () => clock, env: { npm_lifecycle_event: npmScript } });
  reporter.onInit(vitest);
  clock += seconds * 1000;
  reporter.onTestRunEnd([fakeModule(3), fakeModule(2)]);
  return logged;
};

describe('test runtime budget', () => {
  const exitCode = process.exitCode;
  afterEach(() => { process.exitCode = exitCode; });

  it('reports the time and test count of a run within budget', () => {
    expect(checkRuntimeBudget({ seconds: 61.94, tests: 798, files: 81 }, 150))
      .toEqual({ over: false, message: 'Test budget: 798 tests in 81 files took 61.9s (budget 150s)' });
    expect(run(12, 20)).toEqual({ log: ['Test budget: 5 tests in 2 files took 12.0s (budget 20s)'], error: [] });
    expect(process.exitCode).toBe(exitCode);
  });

  it('fails the run when it goes over budget', () => {
    const logged = run(20.5, 20);
    expect(logged.log).toEqual([]);
    expect(logged.error).toEqual([expect.stringMatching(/^Test budget: 5 tests in 2 files took 20\.5s \(budget 20s\): over budget/)]);
    expect(process.exitCode).toBe(1);
  });

  it('leaves runs outside npm test, and watch runs, alone', () => {
    expect(run(20.5, 20, { npmScript: '' })).toEqual({ log: [], error: [] });
    expect(run(20.5, 20, { npmScript: 'test:browser' })).toEqual({ log: [], error: [] });
    expect(run(20.5, 20, { watch: true })).toEqual({ log: [], error: [] });
    expect(process.exitCode).toBe(exitCode);
  });

  it('defaults to the recorded budget', () => {
    expect(checkRuntimeBudget({ seconds: RUNTIME_BUDGET_SECONDS, tests: 1, files: 1 }).over).toBe(false);
    expect(checkRuntimeBudget({ seconds: RUNTIME_BUDGET_SECONDS + 0.1, tests: 1, files: 1 }).over).toBe(true);
  });
});

describe('test budget wiring', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const npmTest = (JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { scripts: { test: string } }).scripts.test;

  // Resolves Vitest's config for `npm test -- <flags>` the way the CLI does, without running tests.
  it.each([[], ['--reporter=dot'], ['--reporter=json', '--coverage.enabled=false']])('keeps the budget reporter in npm test %j', async (...flags: string[]) => {
    const { options } = parseCLI([...npmTest.split(' '), ...flags]);
    const vitest = await createVitest('test', { ...options, root, watch: false });
    try {
      // createVitest loads the configured reporters, so a bad path would already have thrown.
      expect(vitest.config.reporters.filter((reporter) => Array.isArray(reporter) && reporter[0] === TEST_BUDGET_REPORTER)).toEqual([[TEST_BUDGET_REPORTER, {}]]);
    } finally { await vitest.close(); }
  }, 30000);
});
