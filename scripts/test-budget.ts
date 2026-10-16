import { fileURLToPath } from 'node:url';
import type { Reporter, TestModule, Vitest, VitestPluginContext } from 'vitest/node';

/**
 * Wall-time budget for `npm test` (the whole suite, with coverage). The baseline for 798 tests was
 * 61.9-64.9s with coverage on a shared 4-core container and 53.5-62.7s on CI without; see
 * docs/DEVELOPMENT.md (Test budgets) before changing it. The coverage floors live in vite.config.ts
 * (test.coverage.thresholds).
 */
export const RUNTIME_BUDGET_SECONDS = 150;

export interface RunTotals { seconds: number; tests: number; files: number }

/** The summary line for a run, and whether it went over its budget. */
export const checkRuntimeBudget = (run: RunTotals, budgetSeconds = RUNTIME_BUDGET_SECONDS) => {
  const over = run.seconds > budgetSeconds;
  const line = `Test budget: ${run.tests} tests in ${run.files} files took ${run.seconds.toFixed(1)}s (budget ${budgetSeconds}s)`;
  return { over, message: over ? `${line}: over budget, find the slow tests or raise the budget (docs/DEVELOPMENT.md)` : line };
};

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
 * the run's wall time and test count, and fails the run when it is over budget. Other runs, such as
 * targeted `npx vitest run <path>` and watch runs, are left alone.
 */
export default class TestBudgetReporter implements Reporter {
  private vitest?: Vitest;
  private start = 0;
  private readonly budgetSeconds: number;
  private readonly now: () => number;
  private readonly env: Record<string, string | undefined>;

  constructor(options: { budgetSeconds?: number; now?: () => number; env?: Record<string, string | undefined> } = {}) {
    this.budgetSeconds = options.budgetSeconds ?? RUNTIME_BUDGET_SECONDS;
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
    const seconds = (this.now() - this.start) / 1000;
    const { over, message } = checkRuntimeBudget({ seconds, tests, files: testModules.length }, this.budgetSeconds);
    if (over) {
      this.vitest.logger.error(message);
      process.exitCode = 1;
    } else this.vitest.logger.log(message);
  }
}
