import { describe, expect, it } from 'vitest';
import { ARGON2_BYTES_PER_JOB, summarizeOptional, validateOptionalRun, type OptionalRun } from './optional-work';

const run = (scenario: OptionalRun['scenario'] = 'optional-active'): OptionalRun => ({
  scenario, repetition: 1, status: 'passed',
  measurement: {
    browser: 'test-fixture', device: { hardwareConcurrency: 4, deviceMemory: null },
    navigationToClickableMs: 10, liveTicketMs: 5, openToSummaryMs: 15, openToResultMs: 20,
    workers: { created: 3, peakBusy: 2, optionalInFlightAtPress: 1, optionalStartedBeforeSummary: 0, optionalFinishedBeforeSummary: 1, optionalStartedAfterSummary: 2 },
    estimatedArgon2PeakBytes: 2 * ARGON2_BYTES_PER_JOB,
    memory: { supported: false, reason: 'test fixture: unavailable' },
  },
});

describe('optional-work report contract', () => {
  it('keeps the Argon2 estimate apart from measured memory, per scenario', () => {
    const inactive = run('optional-inactive');
    inactive.measurement!.workers.optionalInFlightAtPress = 0;
    const [idle, busy] = summarizeOptional([inactive, run()]);
    expect(idle.scenario).toBe('optional-inactive');
    expect(busy.estimatedArgon2PeakBytes).toEqual({ count: 1, median: 2 * ARGON2_BYTES_PER_JOB, min: 2 * ARGON2_BYTES_PER_JOB, max: 2 * ARGON2_BYTES_PER_JOB });
    expect(busy.measuredMainTargetHeapUsedBytes).toEqual({ count: 0, median: null, min: null, max: null });
    expect(busy.optionalStartedBeforeSummary.max).toBe(0);
  });

  it('refuses an active run with nothing in flight, or an incomplete measurement', () => {
    const idle = run();
    idle.measurement!.workers.optionalInFlightAtPress = 0;
    expect(() => validateOptionalRun(idle)).toThrow('no optional work');
    const negative = run();
    negative.measurement!.openToSummaryMs = -1;
    expect(() => validateOptionalRun(negative)).toThrow('Invalid measurement number');
    const failed = run(); failed.status = 'failed'; delete failed.measurement;
    expect(summarizeOptional([failed])[1]).toMatchObject({ passedRuns: 0, failedOrIncompleteRuns: 1 });
  });
});
