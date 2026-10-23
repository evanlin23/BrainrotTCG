import { appendFileSync } from 'node:fs';
import { firefox, webkit, chromium } from '@playwright/test';
import type { FullConfig, FullResult, Reporter, TestCase } from '@playwright/test/reporter';
import { compatSummary, type CompatProject } from './compat-summary';

const ENGINES = { chromium, firefox, webkit } as const;

/** Prints, and adds to the job summary, which engine and version each project ran and how its tests ended. */
export default class CompatReporter implements Reporter {
  private config!: FullConfig;
  private tests: TestCase[] = [];
  onBegin(config: FullConfig) {
    this.config = config;
  }
  onTestEnd(test: TestCase) {
    this.tests.push(test);
  }
  printsToStdio() {
    return false;
  }
  async onEnd(_result: FullResult) {
    const projects: CompatProject[] = [];
    for (const project of this.config.projects) {
      const engine = project.use.browserName ?? project.use.defaultBrowserType ?? 'chromium';
      const own = this.tests.filter((test) => test.parent.project()?.name === project.name);
      // A project the run left out (--project) has nothing to report.
      if (own.length === 0) continue;
      const count = (outcome: ReturnType<TestCase['outcome']>) => own.filter((test) => test.outcome() === outcome).length;
      projects.push({
        name: project.name, engine, version: await versionOf(engine),
        passed: count('expected'), failed: count('unexpected'), skipped: count('skipped'), flaky: count('flaky'),
      });
    }
    const summary = compatSummary(projects);
    console.log(`\n${summary}`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

/** The installed build's version: a launch of its own, since a test's browser is closed by now. */
async function versionOf(engine: keyof typeof ENGINES): Promise<string> {
  try {
    const browser = await ENGINES[engine].launch();
    const version = browser.version();
    await browser.close();
    return version;
  } catch {
    return 'unknown';
  }
}
