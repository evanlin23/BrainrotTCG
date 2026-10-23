/** One project of the cross-browser smoke: the engine it ran on and what each test ended as. */
export interface CompatProject {
  name: string;
  engine: string;
  version: string;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
}

/**
 * The run's report as a markdown table, one row per project, for the log and the job summary.
 * "Linux WebKit" is Playwright's own build with touch emulation, so the note says what it is not.
 */
export function compatSummary(projects: readonly CompatProject[]): string {
  const rows = projects.map((p) => `| ${p.name} | ${p.engine} ${p.version} | ${p.passed} | ${p.failed} | ${p.skipped} | ${p.flaky} |`);
  return [
    '### Cross-browser smoke',
    '',
    '| Project | Engine | Passed | Failed | Skipped | Flaky |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
    ...rows,
    '',
    'Playwright builds on Linux. WebKit with touch emulation is not iOS Safari, a physical phone or its native share sheet.',
    '',
  ].join('\n');
}
