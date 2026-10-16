export const PROFILE = {
  name: 'constrained-chromium', cpuSlowdown: 4,
  network: { offline: false, latency: 40, downloadThroughput: 10_000_000 / 8, uploadThroughput: 2_000_000 / 8 },
  viewport: { width: 393, height: 727 },
} as const;
/** Runs per scenario: 3 by default; `PERF_REPETITIONS=7` (an integer from 1 to 50) takes a larger sample by hand. */
export const repetitionsFrom = (raw: string | undefined): number => {
  if (raw === undefined || raw === '') return 3;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error(`PERF_REPETITIONS must be an integer from 1 to 50, got "${raw}"`);
  return count;
};
export const REPETITIONS = repetitionsFrom(process.env.PERF_REPETITIONS);
// Cold scenarios keep their names and order; warm ones repeat the journey after a priming load.
export const SCENARIOS = ['first-cold', 'synthetic-history-cold', 'first-warm', 'synthetic-history-warm'] as const;
export type Scenario = typeof SCENARIOS[number];
export const cacheOf = (scenario: Scenario) => scenario.endsWith('-warm') ? 'warm' as const : 'cold' as const;
export const historyRecordsOf = (scenario: Scenario) => scenario.startsWith('synthetic-history') ? 100 : 0;

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
  /** Warm runs only: what the priming load left behind and how the measured load reused it. */
  warm?: { indexedDBDatabases: string[]; servedFromCache: number; notModified: number };
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
  if (cacheOf(run.scenario) === 'warm') {
    const w = m.warm;
    if (!w || !Array.isArray(w.indexedDBDatabases) || [w.servedFromCache, w.notModified].some((n) => !Number.isInteger(n) || n < 0)) {
      throw new Error('Passed warm run needs warm cache details');
    }
  }
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
      scenario, cache: cacheOf(scenario), expectedRuns: REPETITIONS, recordedRuns: selected.length, passedRuns: measured.length,
      failedOrIncompleteRuns: selected.filter((run) => run.status !== 'passed').length,
      navigationToClickableMs: range(measured.map((m) => m.navigationToClickableMs)),
      openToResultMs: range(measured.map((m) => m.openToResultMs)),
      encodedTransferBytes: range(measured.map((m) => m.transfer.encodedBytes)),
      workerCount: range(measured.map((m) => m.workersCreated)),
      longTaskTotalMs: range(measured.flatMap((m) => m.longTasks.supported ? [m.longTasks.value.totalMs] : [])),
      maximumFrameIntervalMs: range(measured.map((m) => m.frames.maxIntervalMs)),
      mainTargetHeapUsedBytes: range(measured.flatMap((m) => m.memory.supported ? [m.memory.value.usedBytes] : [])),
      ...(cacheOf(scenario) === 'warm' ? {
        servedFromCacheRequests: range(measured.map((m) => m.warm!.servedFromCache)),
        notModifiedRequests: range(measured.map((m) => m.warm!.notModified)),
      } : {}),
    };
  });
}
