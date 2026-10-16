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
  if (!m?.browser || !m.workers || !m.device || !m.memory) throw new Error('Passed run needs a browser and complete measurement');
  const numbers = [m.navigationToClickableMs, m.liveTicketMs, m.openToSummaryMs, m.openToResultMs, m.estimatedArgon2PeakBytes,
    m.device.hardwareConcurrency, ...Object.values(m.workers)];
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
      measuredMainTargetHeapUsedBytes: range(measured.flatMap((m) => m.memory.supported ? [m.memory.value.usedBytes] : [])),
    };
  });
}
