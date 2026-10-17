import { TICKET_PARAMS } from '../../src/engine/ticket';
import { REPETITIONS, range, type Observation } from './report';

/**
 * Opt-in fixture (#342): the baseline's throttled profile and opening journey, once with optional
 * work idle and once with packs being re-opened in the background. Only that differs.
 */
export const OPTIONAL_SCENARIOS = ['optional-inactive', 'optional-active'] as const;
export type OptionalScenario = typeof OPTIONAL_SCENARIOS[number];
/** Both seed this many synthetic history records; the active one leaves their cards out to re-open. */
export const OPTIONAL_HISTORY_RECORDS = 24;
/** Argon2id memory one ticket job allocates (TICKET_PARAMS), for the estimate. Not measured. */
export const ARGON2_BYTES_PER_JOB = TICKET_PARAMS.memorySize * 1024;
export const EVIDENCE = 'desktop-Chromium emulation, not real-device evidence (real devices: #8)';

export interface Responsiveness {
  /** Main-thread tasks over 50 ms (the Long Tasks API) that began in the window. */
  longTasks: number;
  longTaskTotalMs: number;
  longTaskMaxMs: number;
  /** requestAnimationFrame callbacks in the window, and the gaps between consecutive ones. */
  frames: number;
  maxFrameIntervalMs: number;
  framesOver50Ms: number;
}

/** What the page recorded: long tasks as start and duration, and every animation frame's timestamp. */
export interface ResponsivenessSamples {
  longTasks: { start: number; duration: number }[];
  frames: number[];
}

/** Reduces the page's samples to the window from the press (`from`) to the result (`to`), both in performance.now() ms. */
export function responsivenessBetween(samples: ResponsivenessSamples, from: number, to: number): Responsiveness {
  const tasks = samples.longTasks.filter((task) => task.start >= from && task.start <= to);
  const frames = samples.frames.filter((t) => t >= from && t <= to);
  const intervals = frames.slice(1).map((t, i) => t - frames[i]);
  return {
    longTasks: tasks.length,
    longTaskTotalMs: tasks.reduce((sum, task) => sum + task.duration, 0),
    longTaskMaxMs: Math.max(0, ...tasks.map((task) => task.duration)),
    frames: frames.length,
    maxFrameIntervalMs: Math.max(0, ...intervals),
    framesOver50Ms: intervals.filter((gap) => gap > 50).length,
  };
}

export interface OptionalMeasurement {
  browser: string;
  device: { hardwareConcurrency: number; deviceMemory: number | null };
  navigationToClickableMs: number;
  /** First request for the live ticket (the next pack's nonce) to its answer. */
  liveTicketMs: number;
  /** Press with the live ticket ready, to the first frame with the summary (the held part). */
  openToSummaryMs: number;
  /** Press with the live ticket ready, to five decoded summary cards. */
  openToResultMs: number;
  workers: {
    created: number;
    peakBusy: number;
    optionalInFlightAtPress: number;
    /** Started from the press to the summary, while the pack holds optional work: expected 0. */
    optionalStartedBeforeSummary: number;
    /** Already mining at the press, so allowed to finish while held. */
    optionalFinishedBeforeSummary: number;
    /** Started between the summary and its decoded cards; the summary holds them until decode or a 2 s cap. */
    optionalStartedAfterSummary: number;
  };
  /** Estimated, never measured: peak busy workers × Argon2 memory per job. */
  estimatedArgon2PeakBytes: number;
  /** The page's main thread from the press to five decoded summary cards. */
  responsiveness: Responsiveness;
  memory: Observation<{ scope: 'main-target-js-heap-only'; usedBytes: number; totalBytes: number }>;
}
export interface OptionalRun {
  scenario: OptionalScenario;
  repetition: number;
  status: string;
  measurement?: OptionalMeasurement;
  error?: string;
}

/** A passed run must be complete, and an active one must really have had optional work mining. */
export function validateOptionalRun(run: OptionalRun) {
  if (!OPTIONAL_SCENARIOS.includes(run.scenario) || !Number.isInteger(run.repetition) || run.repetition < 1 || run.repetition > REPETITIONS) {
    throw new Error('Invalid scenario/repetition');
  }
  if (run.status !== 'passed') return;
  const m = run.measurement;
  if (!m?.browser || !m.workers || !m.device || !m.memory || !m.responsiveness) throw new Error('Passed run needs a browser and complete measurement');
  const numbers = [m.navigationToClickableMs, m.liveTicketMs, m.openToSummaryMs, m.openToResultMs, m.estimatedArgon2PeakBytes,
    m.device.hardwareConcurrency, ...Object.values(m.workers), ...Object.values(m.responsiveness)];
  if (numbers.some((n) => !Number.isFinite(n) || n < 0)) throw new Error('Invalid measurement number');
  if (!m.memory.supported && !m.memory.reason) throw new Error('Unsupported observation needs a reason');
  if (run.scenario === 'optional-active' && m.workers.optionalInFlightAtPress < 1) throw new Error('Active run had no optional work in flight');
}

export function summarizeOptional(runs: OptionalRun[]) {
  runs.forEach(validateOptionalRun);
  return OPTIONAL_SCENARIOS.map((scenario) => {
    const selected = runs.filter((run) => run.scenario === scenario);
    const measured = selected.filter((run) => run.status === 'passed').map((run) => run.measurement!);
    return {
      scenario, expectedRuns: REPETITIONS, recordedRuns: selected.length, passedRuns: measured.length,
      failedOrIncompleteRuns: selected.filter((run) => run.status !== 'passed').length,
      openToSummaryMs: range(measured.map((m) => m.openToSummaryMs)),
      openToResultMs: range(measured.map((m) => m.openToResultMs)),
      liveTicketMs: range(measured.map((m) => m.liveTicketMs)),
      navigationToClickableMs: range(measured.map((m) => m.navigationToClickableMs)),
      workersCreated: range(measured.map((m) => m.workers.created)),
      peakBusyWorkers: range(measured.map((m) => m.workers.peakBusy)),
      optionalInFlightAtPress: range(measured.map((m) => m.workers.optionalInFlightAtPress)),
      optionalStartedBeforeSummary: range(measured.map((m) => m.workers.optionalStartedBeforeSummary)),
      optionalFinishedBeforeSummary: range(measured.map((m) => m.workers.optionalFinishedBeforeSummary)),
      optionalStartedAfterSummary: range(measured.map((m) => m.workers.optionalStartedAfterSummary)),
      estimatedArgon2PeakBytes: range(measured.map((m) => m.estimatedArgon2PeakBytes)),
      longTasks: range(measured.map((m) => m.responsiveness.longTasks)),
      longTaskTotalMs: range(measured.map((m) => m.responsiveness.longTaskTotalMs)),
      longTaskMaxMs: range(measured.map((m) => m.responsiveness.longTaskMaxMs)),
      frames: range(measured.map((m) => m.responsiveness.frames)),
      maxFrameIntervalMs: range(measured.map((m) => m.responsiveness.maxFrameIntervalMs)),
      framesOver50Ms: range(measured.map((m) => m.responsiveness.framesOver50Ms)),
      measuredMainTargetHeapUsedBytes: range(measured.flatMap((m) => m.memory.supported ? [m.memory.value.usedBytes] : [])),
    };
  });
}
