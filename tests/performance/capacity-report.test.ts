import { describe, expect, it } from 'vitest';
import {
  CAPS, REPORT_NOTE, SEED, capacityConfig, syntheticSave, validateCapacityReport, writeReport, type CapacityReport,
} from '../browser/capacity';

const report = (): CapacityReport => ({
  schema: 1, scenario: 'growing-save-500', note: REPORT_NOTE, seed: SEED,
  facts: { revision: 'a'.repeat(40), dirty: false, browser: 'test-fixture', project: 'desktop-chromium', device: { hardwareConcurrency: 2, deviceMemory: null, mobile: false } },
  setup: { throttling: 'none', httpCache: 'bypassed by the network guard', indexedDbAtStart: 'empty' },
  samples: { sizes: [500], realPacks: 2 },
  results: [{ phase: 'baseline', size: 500, clickableMs: 1200, heapUsedBytes: 4_000_000, supported: true, label: 'x', missing: null }],
});

describe('capacity report contract (#709)', () => {
  it('accepts a complete report', () => {
    expect(validateCapacityReport(report())).toEqual([]);
  });

  it('rejects anything that is not an object, and a wrong schema, note or seed', () => {
    expect(validateCapacityReport(null)).toEqual(['not an object']);
    expect(validateCapacityReport([])).toEqual(['not an object']);
    expect(validateCapacityReport({ ...report(), schema: 2 })).toContain('schema must be 1');
    expect(validateCapacityReport({ ...report(), note: 'verified on a phone' })).toContain('note must label the data as synthetic emulation');
    expect(validateCapacityReport({ ...report(), seed: 'other' })).toContain('seed missing');
  });

  it('rejects a report with no results or no real pack: it cannot stand for a successful run', () => {
    expect(validateCapacityReport({ ...report(), results: [] })).toContain('a report with no results is not a successful run');
    expect(validateCapacityReport({ ...report(), samples: { sizes: [500], realPacks: 0 } })).toContain('samples incomplete');
    expect(validateCapacityReport({ ...report(), samples: { sizes: [-1], realPacks: 1 } })).toContain('samples incomplete');
  });

  it('rejects a bad revision, and a negative or non-finite figure', () => {
    const base = report();
    expect(validateCapacityReport({ ...base, facts: { ...base.facts, revision: 'abc123' } })).toContain('facts incomplete');
    expect(validateCapacityReport({ ...base, results: [{ clickableMs: -1 }] })).toEqual(['results[0].clickableMs is not a non-negative finite number']);
    expect(validateCapacityReport({ ...base, results: [{ clickableMs: Number.NaN }] })).toEqual(['results[0].clickableMs is not a non-negative finite number']);
    expect(validateCapacityReport({ ...base, results: [{ clickableMs: Number.POSITIVE_INFINITY }] })).toHaveLength(1);
  });

  it('refuses to write a report that is not valid', () => {
    expect(() => writeReport({ ...report(), results: [] })).toThrow(/not valid/);
  });
});

describe('capacity configuration (#709)', () => {
  it('has bounded defaults', () => {
    expect(capacityConfig({})).toEqual({ history: [0, 500, 3000], packs: 2, sessionHistory: 500, sessionPacks: 6, uncached: 4 });
  });

  it('reads digits only, with spaces around list entries allowed', () => {
    expect(capacityConfig({ CAPACITY_HISTORY: '10, 20', CAPACITY_PACKS: '1' }).history).toEqual([10, 20]);
    for (const bad of ['1e3', '-5', '0x10', '1.5', '', 'ten', '5,,6']) {
      // An empty value falls back to the default; the rest must throw.
      if (bad === '') expect(capacityConfig({ CAPACITY_HISTORY: bad }).history).toEqual([0, 500, 3000]);
      else expect(() => capacityConfig({ CAPACITY_HISTORY: bad })).toThrow(/digits only/);
    }
  });

  it('rejects any value over its hard cap', () => {
    expect(() => capacityConfig({ CAPACITY_HISTORY: String(CAPS.history + 1) })).toThrow(/at most/);
    expect(() => capacityConfig({ CAPACITY_PACKS: String(CAPS.packs + 1) })).toThrow(/at most/);
    expect(() => capacityConfig({ CAPACITY_SESSION_PACKS: String(CAPS.sessionPacks + 1) })).toThrow(/at most/);
    expect(() => capacityConfig({ CAPACITY_UNCACHED: String(CAPS.uncached + 1) })).toThrow(/at most/);
    expect(capacityConfig({ CAPACITY_HISTORY: String(CAPS.history) }).history).toEqual([CAPS.history]);
  });
});

describe('capacity synthetic save (#709)', () => {
  it('is deterministic and adds up: 5 cards a record, nonces 0..n-1, the last records without cached cards', () => {
    const { file, expected } = syntheticSave(40, 3);
    expect(syntheticSave(40, 3).file).toBe(file);
    const parsed = JSON.parse(file);
    const history = JSON.parse(parsed.history) as { n: number; c?: string; x: number }[];
    expect(history.map((record) => record.n)).toEqual(Array.from({ length: 40 }, (_, n) => n));
    expect(history.filter((record) => record.c === undefined).map((record) => record.n)).toEqual([37, 38, 39]);
    expect(history.every((record) => record.c === undefined || record.c.split(',').length === 5)).toBe(true);
    const collection = Object.values(JSON.parse(parsed.collection)) as { normalCount: number; holoCount: number }[];
    expect(collection.reduce((sum, entry) => sum + entry.normalCount + entry.holoCount, 0)).toBe(expected.cards);
    expect(expected).toEqual({ packs: 40, cards: 200, nextNonce: 40, uncached: 3 });
    expect(JSON.parse(parsed.player).nextNonce).toBe(40);
  });

  it('is an empty save for zero records', () => {
    const parsed = JSON.parse(syntheticSave(0).file);
    expect(JSON.parse(parsed.history)).toEqual([]);
    expect(JSON.parse(parsed.collection)).toEqual({});
  });
});
