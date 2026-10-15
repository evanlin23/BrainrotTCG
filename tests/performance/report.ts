export const PROFILE = {
  name: 'constrained-chromium', cpuSlowdown: 4,
  network: { offline: false, latency: 40, downloadThroughput: 10_000_000 / 8, uploadThroughput: 2_000_000 / 8 },
  viewport: { width: 393, height: 727 },
} as const;
export const REPETITIONS = 3;
export const SCENARIOS = ['first-cold', 'synthetic-history-cold'] as const;
export type Scenario = typeof SCENARIOS[number];

export type Observation<T> = { supported: true; value: T } | { supported: false; reason: string };
export interface Measurement {
  browser: string;
  fixture: { historyRecordsBefore: number; historyUtf16BytesBefore: number; localStorageUtf16BytesBefore: number; nextNonceBefore: number };
  navigationToClickableMs: number;
  openToResultMs: number;
  transfer: { encodedBytes: number; completedRequests: number; inFlightRequests: number };
  workersCreated: number;
  longTasks: Observation<{ count: number; totalMs: number; maxMs: number }>;
  frames: { count: number; medianIntervalMs: number; maxIntervalMs: number; intervalsOver50Ms: number };
  memory: Observation<{ scope: 'main-target-js-heap-only'; usedBytes: number; totalBytes: number }>;
}
export interface Run {
  scenario: Scenario;
  repetition: number;
  status: string;
  measurement?: Measurement;
  error?: string;
}
export const range = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length ? {
    count: sorted.length, median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0], max: sorted[sorted.length - 1],
  } : { count: 0, median: null, min: null, max: null };
};

/** Validate successful measurements before reporting; incomplete/failed runs never become timings. */
export function validateRun(run: Run) {
  if (!SCENARIOS.includes(run.scenario) || !Number.isInteger(run.repetition) || run.repetition < 1 || run.repetition > REPETITIONS) {
    throw new Error('Invalid scenario/repetition');
  }
  if (run.status !== 'passed') return;
  const m = run.measurement;
  if (!m || !m.browser) throw new Error('Passed run needs a browser and complete measurement');
  const numbers = [m.navigationToClickableMs, m.openToResultMs, m.transfer?.encodedBytes, m.transfer?.completedRequests,
    m.transfer?.inFlightRequests, m.workersCreated, m.frames?.count, m.frames?.medianIntervalMs,
    m.frames?.maxIntervalMs, m.frames?.intervalsOver50Ms, m.fixture?.historyRecordsBefore,
    m.fixture?.historyUtf16BytesBefore, m.fixture?.localStorageUtf16BytesBefore, m.fixture?.nextNonceBefore];
  if (numbers.some((n) => !Number.isFinite(n) || n < 0)) throw new Error('Invalid measurement number');
  for (const observation of [m.longTasks, m.memory]) {
    if (!observation || typeof observation.supported !== 'boolean') throw new Error('Missing observation support status');
    if (!observation.supported && !observation.reason) throw new Error('Unsupported observation needs a reason');
    if (observation.supported && Object.values(observation.value).some((v) => typeof v === 'number' && (!Number.isFinite(v) || v < 0))) {
      throw new Error('Invalid supported observation');
    }
  }
}

export function summarize(runs: Run[]) {
  runs.forEach(validateRun);
  return SCENARIOS.map((scenario) => {
    const selected = runs.filter((run) => run.scenario === scenario);
    const measured = selected.filter((run) => run.status === 'passed').map((run) => run.measurement!);
    return {
      scenario, expectedRuns: REPETITIONS, recordedRuns: selected.length, passedRuns: measured.length,
      failedOrIncompleteRuns: selected.filter((run) => run.status !== 'passed').length,
      navigationToClickableMs: range(measured.map((m) => m.navigationToClickableMs)),
      openToResultMs: range(measured.map((m) => m.openToResultMs)),
      encodedTransferBytes: range(measured.map((m) => m.transfer.encodedBytes)),
      workerCount: range(measured.map((m) => m.workersCreated)),
      longTaskTotalMs: range(measured.flatMap((m) => m.longTasks.supported ? [m.longTasks.value.totalMs] : [])),
      maximumFrameIntervalMs: range(measured.map((m) => m.frames.maxIntervalMs)),
      mainTargetHeapUsedBytes: range(measured.flatMap((m) => m.memory.supported ? [m.memory.value.usedBytes] : [])),
    };
  });
}
