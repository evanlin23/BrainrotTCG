import { describe, expect, it } from 'vitest';
import { summarize, validateRun, type Run } from './report';

const run = (): Run => ({
  scenario: 'first-cold', repetition: 1, status: 'passed',
  measurement: {
    browser: 'test-fixture', navigationToClickableMs: 10, openToResultMs: 20,
    fixture: { historyRecordsBefore: 0, historyUtf16BytesBefore: 0, localStorageUtf16BytesBefore: 200, nextNonceBefore: 0 },
    transfer: { encodedBytes: 100, completedRequests: 2, inFlightRequests: 0 }, workersCreated: 1,
    longTasks: { supported: false, reason: 'test fixture: unavailable' },
    frames: { count: 1, medianIntervalMs: 16, maxIntervalMs: 16, intervalsOver50Ms: 0 },
    memory: { supported: false, reason: 'test fixture: unavailable' },
  },
});
describe('performance report contract', () => {
  it('retains unsupported observations and summarizes comparable successful runs', () => {
    const a = run();
    const b = run(); b.repetition = 2; b.measurement!.openToResultMs = 40;
    const summary = summarize([a, b])[0];
    expect(summary.openToResultMs).toEqual({ count: 2, median: 30, min: 20, max: 40 });
    expect(summary.mainTargetHeapUsedBytes).toEqual({ count: 0, median: null, min: null, max: null });
    expect(summary.recordedRuns).toBe(2);
    expect(summary.expectedRuns).toBe(3);
  });
  it('does not turn a functional failure or unfinished run into a timing success', () => {
    const failed = run(); failed.status = 'failed'; failed.error = 'intentional collection mismatch';
    const incomplete = run(); incomplete.status = 'timedOut'; delete incomplete.measurement;
    const summary = summarize([failed, incomplete])[0];
    expect(summary.passedRuns).toBe(0);
    expect(summary.failedOrIncompleteRuns).toBe(2);
    expect(summary.openToResultMs.count).toBe(0);
  });
  it('rejects malformed successful measurements and unidentified unsupported observations', () => {
    const invalid = run(); invalid.measurement!.openToResultMs = Number.NaN;
    expect(() => validateRun(invalid)).toThrow('Invalid measurement number');
    const missing = run(); delete missing.measurement;
    expect(() => validateRun(missing)).toThrow('complete measurement');
    const unsupported = run(); unsupported.measurement!.memory = { supported: false, reason: '' };
    expect(() => validateRun(unsupported)).toThrow('needs a reason');
  });
  it('reports warm runs separately from cold ones and requires their cache details', () => {
    const cold = run();
    const warm = run(); warm.scenario = 'first-warm'; warm.measurement!.openToResultMs = 5;
    warm.measurement!.warm = { indexedDBDatabases: [], servedFromCache: 2, notModified: 11 };
    const [first, , firstWarm] = summarize([cold, warm]);
    expect(first).toMatchObject({ scenario: 'first-cold', cache: 'cold', passedRuns: 1, openToResultMs: { median: 20 } });
    expect(first).not.toHaveProperty('notModifiedRequests');
    expect(first).not.toHaveProperty('servedFromCacheRequests');
    expect(firstWarm).toMatchObject({
      scenario: 'first-warm', cache: 'warm', passedRuns: 1, openToResultMs: { median: 5 },
      servedFromCacheRequests: { median: 2 }, notModifiedRequests: { median: 11 },
    });
    delete warm.measurement!.warm;
    expect(() => validateRun(warm)).toThrow('warm cache details');
  });
});
