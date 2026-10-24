import { fileURLToPath } from 'node:url';
import type { Reporter, TestModule, Vitest, VitestPluginContext } from 'vitest/node';

/**
 * The per-test and per-hook timeout for every Vitest run (vite.config.ts). It only catches a test that
 * hangs: the slowest test in a full `npm test` run with coverage takes about 6 s, so even at 4x CPU
 * contention (about 23 s) it stays 5x below this. Wall time never fails a run otherwise.
 * See docs/DEVELOPMENT.md (Test timing) before changing it.
 */
export const HANG_TIMEOUT_MS = 120_000;

export interface RunTotals { seconds: number; tests: number; files: number }

/**
 * The run's summary line. Report-only: wall time depends on the machine and what else runs on it, so
 * it can't tell a slow test from a busy runner, and no figure here fails a run.
 */
export const runSummary = (run: RunTotals) => `Test time: ${run.tests} tests in ${run.files} files took ${run.seconds.toFixed(1)}s (report-only)`;

/** This reporter's module, as Vitest loads it. */
export const TEST_BUDGET_REPORTER = fileURLToPath(import.meta.url);

/**
 * Vite plugin (in vite.config.ts) that adds this reporter to every Vitest run. It runs after the
 * config is resolved, so a `--reporter` flag, which replaces `test.reporters`, can't drop it.
 */
export const testBudget = () => ({
  name: 'test-budget',
  configureVitest({ vitest }: VitestPluginContext) {
    const { reporters } = vitest.config;
    if (!reporters.some((reporter) => Array.isArray(reporter) && reporter[0] === TEST_BUDGET_REPORTER)) reporters.push([TEST_BUDGET_REPORTER, {}]);
  },
});

/**
 * Vitest reporter for `npm test` runs, whatever flags they add (`--reporter`, coverage off): prints
 * the run's wall time and test count, and never changes the run's result. Other runs, such as
 * targeted `npx vitest run <path>` and watch runs, are left alone.
 */
export default class TestBudgetReporter implements Reporter {
  private vitest?: Vitest;
  private start = 0;
  private readonly now: () => number;
  private readonly env: Record<string, string | undefined>;

  constructor(options: { now?: () => number; env?: Record<string, string | undefined> } = {}) {
    this.now = options.now ?? (() => performance.now());
    this.env = options.env ?? process.env;
  }

  onInit(vitest: Vitest) {
    this.vitest = vitest;
    this.start = this.now();
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    // npm sets this for `npm test`, including the one inside `npm run check`.
    if (this.env.npm_lifecycle_event !== 'test' || !this.vitest || this.vitest.config.watch) return;
    const tests = testModules.reduce((count, testModule) => count + [...testModule.children.allTests()].length, 0);
    this.vitest.logger.log(runSummary({ seconds: (this.now() - this.start) / 1000, tests, files: testModules.length }));
  }
}
