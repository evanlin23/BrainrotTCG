import type { Reporter, TestModule, Vitest } from 'vitest/node';

/**
 * Wall-time budget for `npm test` (the whole suite, with coverage). The baseline was about 62s for
 * 798 tests on a 4-core machine and 53-63s on CI; see docs/DEVELOPMENT.md (Test budgets) before
 * changing it. The coverage floors live in vite.config.ts (test.coverage.thresholds).
 */
export const RUNTIME_BUDGET_SECONDS = 150;

export interface RunTotals { seconds: number; tests: number; files: number }

/** The summary line for a run, and whether it went over its budget. */
export const checkRuntimeBudget = (run: RunTotals, budgetSeconds = RUNTIME_BUDGET_SECONDS) => {
  const over = run.seconds > budgetSeconds;
  const line = `Test budget: ${run.tests} tests in ${run.files} files took ${run.seconds.toFixed(1)}s (budget ${budgetSeconds}s)`;
  return { over, message: over ? `${line}: over budget, find the slow tests or raise the budget (docs/DEVELOPMENT.md)` : line };
};

/**
 * Vitest reporter for full runs (`npm test`, which turns coverage on): prints the run's wall time and
 * test count, and fails the run when it is over budget. Targeted and watch runs are left alone.
 */
export default class TestBudgetReporter implements Reporter {
  private vitest?: Vitest;
  private start = 0;
  private readonly budgetSeconds: number;
  private readonly now: () => number;

  constructor(options: { budgetSeconds?: number; now?: () => number } = {}) {
    this.budgetSeconds = options.budgetSeconds ?? RUNTIME_BUDGET_SECONDS;
    this.now = options.now ?? (() => performance.now());
  }

  onInit(vitest: Vitest) {
    this.vitest = vitest;
    this.start = this.now();
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
    if (!this.vitest?.config.coverage.enabled || this.vitest.config.watch) return;
    const tests = testModules.reduce((count, testModule) => count + [...testModule.children.allTests()].length, 0);
    const seconds = (this.now() - this.start) / 1000;
    const { over, message } = checkRuntimeBudget({ seconds, tests, files: testModules.length }, this.budgetSeconds);
    if (over) {
      this.vitest.logger.error(message);
      process.exitCode = 1;
    } else this.vitest.logger.log(message);
  }
}
