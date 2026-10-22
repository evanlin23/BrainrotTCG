/**
 * Fixture test for the offline intake capacity harness (scripts/hof-capacity.ts, #708): small
 * scenarios through the real `inbox()` with the shipped caps, the summaries' invariants, and the
 * bounded exits. Everything is in memory; ticket verification is stubbed, so it runs in seconds.
 * The long presets (paging-cap, the 30 packs/second synthetic) are not run here.
 */
import { describe, expect, it } from 'vitest';
import {
  measureArgon2, resolveScenario, runnerMeta, runScenario, SCENARIOS, SCHEMA, selectScenarios, summaryLines,
  type ScenarioInput, type Summary,
} from './hof-capacity.ts';
import { HOF_RELAYS } from '../src/game/nostrInbox.ts';
import { INBOX_BUDGET, INBOX_MAX_FILED } from './hall-of-fame.ts';

const KINDS = ['qualifying', 'duplicate', 'invalid', 'nonqualifying'] as const;

/** What every summary must satisfy, whatever the scenario. */
const expectConsistent = (s: Summary) => {
  expect(s.schema).toBe(SCHEMA);
  expect(JSON.parse(JSON.stringify(s))).toEqual(s); // plain data: it can be written out as the raw summary
  expect(s.labels.verification).toMatch(/stubbed/);
  expect(s.labels.time).toMatch(/fake clock/);
  expect(s.labels.capacity).toMatch(/modeled/);
  expect(s.meta.seed).toBe(s.config.seed);
  expect(s.totals.arrived).toBe(s.runs.reduce((n, r) => n + r.arrived, 0));
  for (const r of s.runs) {
    for (const v of [r.arrived, r.onRelays, r.eventsRead, r.beyondPaging, r.budgetUsed, r.filed, r.deferred, r.backlog, r.oldestBacklogAgeS, r.relayRequests, r.modeledRunS]) expect(v).toBeGreaterThanOrEqual(0);
    expect(r.budgetUsed).toBeLessThanOrEqual(INBOX_BUDGET);
    expect(r.filed).toBeLessThanOrEqual(INBOX_MAX_FILED);
  }
  // Every event is exactly one of handled, expired before handling (by window or by relay retention) or still waiting.
  for (const k of KINDS) {
    const c = s.totals.kinds[k];
    expect(c.handled + c.backlog + c.expiredWindow + c.expiredRetention).toBe(c.arrived);
  }
  expect(KINDS.reduce((n, k) => n + s.totals.kinds[k].arrived, 0)).toBe(s.totals.arrived);
  const p = s.totals.pulls;
  expect(p.delivered + p.pending + p.expiredBeforeHandled + p.lost).toBe(p.qualifying);
  expect(s.timing.note).toMatch(/report-only/);
};
const expectPassed = (s: Summary) => {
  expectConsistent(s);
  expect(s.checks.filter((c) => !c.ok)).toEqual([]);
  expect(s.exit).toBe('completed');
};
const withoutTiming = (s: Summary) => ({ ...s, timing: undefined });
const run = async (input: ScenarioInput) => runScenario({ model: { argonMs: 100 }, ...input });

describe('shipped caps', () => {
  it('spends at most 300 derivation attempts a run, defers the rest, and reads every page', async () => {
    // 305 events, most with bad signatures: invalid proofs spend the budget too.
    const s = await run({ name: 'budget', runs: 2, phases: [{ fromS: 0, toS: 900, ratePerS: 305 / 900 }], invalidFraction: 0.9, qualifyingFraction: 0.5 });
    expectPassed(s);
    expect(s.meta.shipped).toMatchObject({ budget: 300, maxFiled: 20, pageSize: 100, pages: 50, windowS: 7 * 86_400, seenCap: 20_000 });
    const [first, second] = s.runs;
    expect([first.arrived, first.eventsRead, first.beyondPaging]).toEqual([305, 305, 0]);
    expect(first.relayRequests).toBeGreaterThanOrEqual(HOF_RELAYS.length * 4); // 4 pages of 100 on each relay
    expect([first.budgetUsed, first.deferred]).toEqual([300, 5]);
    expect(first.backlog).toBe(5);
    expect(second.backlog).toBe(0);
    expect(s.drain.runsToDrain).toBeLessThanOrEqual(1);
    expect(s.config.model.argonMs).toBe(100);
    expect(first.modeledRunS).toBeGreaterThan(20); // its derivations x 100 ms plus the request latencies, modeled
  }, 30_000);

  it('files at most 20 entries a run and drains the rest over later runs', async () => {
    const s = await run({ name: 'filing', runs: 3, phases: [{ fromS: 0, toS: 900, ratePerS: 30 / 900 }], qualifyingFraction: 1 });
    expectPassed(s);
    expect(s.runs.map((r) => r.filed)).toEqual([20, 10, 0]);
    expect(s.runs.map((r) => r.backlog)).toEqual([10, 0, 0]);
    expect(s.totals.pulls).toMatchObject({ qualifying: 30, delivered: 30, pending: 0, lost: 0 });
    expect(s.drain).toMatchObject({ lastArrivalRun: 1, backlogZeroAtRun: 2, runsToDrain: 1 });
  }, 30_000);
});

describe('outages and expiry', () => {
  it('keeps its state through a GitHub outage and drains after it', async () => {
    const s = await run({ name: 'gh-down', runs: 6, phases: [{ fromS: 0, toS: 1800, ratePerS: 20 / 1800 }], qualifyingFraction: 1, githubOutage: { fromS: 1000, durationS: 1800 } });
    expectPassed(s);
    expect(s.runs.map((r) => r.outcome)).toEqual(['ok', 'failed', 'failed', 'ok', 'ok', 'ok']);
    expect(s.totals.failedRuns).toBe(2);
    expect(s.runs[1].github.failed).toBeGreaterThan(0);
    expect(s.runs[1].filed).toBe(0);
    expect(s.runs[2].oldestBacklogAgeS).toBeGreaterThan(s.runs[1].oldestBacklogAgeS);
    expect(s.totals.pulls).toMatchObject({ delivered: 20, pending: 0, lost: 0 });
    expect(s.totals.derivations).toBeGreaterThanOrEqual(20);
  }, 30_000);

  it('counts the 7-day window expiring apart from delivery after a relay outage', async () => {
    const s = await run({
      name: 'relay-down', runs: 12, cadenceS: 86_400, qualifyingFraction: 1,
      phases: [{ fromS: 0, toS: 86_400, ratePerS: 0.0003 }, { fromS: 777_600, toS: 864_000, ratePerS: 0.0001 }],
      relayOutage: { fromS: 86_400, durationS: 8 * 86_400 },
    });
    expectPassed(s);
    expect(s.runs[0].relaysFailed).toBe(HOF_RELAYS.length);
    expect(s.runs[0].eventsRead).toBe(0);
    expect(s.totals.kinds.qualifying.expiredWindow).toBe(s.runs[0].arrived); // the first batch aged out unread
    expect(s.totals.kinds.qualifying.expiredRetention).toBe(0);
    expect(s.totals.pulls.expiredBeforeHandled).toBe(s.runs[0].arrived);
    expect(s.totals.pulls.delivered).toBe(s.totals.arrived - s.runs[0].arrived); // later arrivals were not lost to it
    expect(s.totals.pulls.lost).toBe(0);
  }, 30_000);

  it('counts relay retention expiry apart from the read window', async () => {
    const s = await run({ name: 'retention', runs: 3, cadenceS: 7200, qualifyingFraction: 1, phases: [{ fromS: 0, toS: 14_400, ratePerS: 0.002 }], relayRetentionS: 3600 });
    expectPassed(s);
    expect(s.totals.kinds.qualifying.expiredRetention).toBeGreaterThan(0);
    expect(s.totals.kinds.qualifying.expiredWindow).toBe(0);
    expect(s.totals.pulls.expiredBeforeHandled).toBe(s.totals.kinds.qualifying.expiredRetention);
    expect(s.totals.pulls.delivered + s.totals.pulls.expiredBeforeHandled).toBe(s.totals.pulls.qualifying);
  }, 30_000);
});

describe('replay and seen-cache retention', () => {
  it('finishes interrupted filings on the next run without filing twice', async () => {
    // 105 existing issues make the issue listing take two pages; writes 2, 3 and 7 fail part-way.
    const s = await run({ name: 'interrupted', runs: 4, phases: [{ fromS: 0, toS: 900, ratePerS: 10 / 900 }], qualifyingFraction: 1, githubFailWrites: [2, 3, 7], existingIssues: 105 });
    expectPassed(s);
    expect(s.totals.githubFailed).toBe(3);
    expect(s.totals.pulls).toMatchObject({ qualifying: 10, delivered: 10, pending: 0, lost: 0 });
    expect(s.runs[0].github.reads).toBeGreaterThanOrEqual(2); // paged issue listing
    expect(s.runs[1].filed + s.runs[2].filed + s.runs[3].filed).toBeGreaterThan(0); // a later run did the rest
  }, 30_000);

  it('re-derives handled events once the seen cache overflows, without filing again', async () => {
    const s = await run({ name: 'seen-overflow', runs: 2, phases: [{ fromS: 0, toS: 900, ratePerS: 20 / 900 }], invalidFraction: 0.5, qualifyingFraction: 0.5, seenFillerPerRun: 20_000 });
    expectPassed(s);
    expect(s.runs[1].arrived).toBe(0);
    expect(s.runs[1].budgetUsed).toBeGreaterThan(0); // nothing new, yet attempts are spent again
    expect(s.totals.derivations).toBeGreaterThan(s.totals.kinds.qualifying.arrived + s.totals.kinds.nonqualifying.arrived);
    expect(s.totals.pulls.lost).toBe(0);
  }, 30_000);
});

describe('bounded exits', () => {
  const small: ScenarioInput = { name: 'small', runs: 4, phases: [{ fromS: 0, toS: 3600, ratePerS: 6 / 3600 }], qualifyingFraction: 1 };

  it('stops before generating more than maxEvents, and says so', async () => {
    const s = await run({ ...small, bounds: { maxEvents: 3 } });
    expectConsistent(s);
    expect(s.exit).toBe('aborted: maxEvents');
    expect(s.totals.arrived).toBeLessThanOrEqual(3);
    expect(s.runs.length).toBeLessThan(4);
    expect(s.checks.find((c) => c.name === 'stayed within resource bounds')?.ok).toBe(false);
  }, 30_000);

  it('stops after a run once the wall-time or heap bound is passed', async () => {
    const wall = await run({ ...small, bounds: { maxWallMs: 0 } });
    expectConsistent(wall);
    expect([wall.exit, wall.runs.length]).toEqual(['aborted: maxWallMs', 1]);
    const heap = await run({ ...small, bounds: { maxHeapMb: 1 } });
    expectConsistent(heap);
    expect([heap.exit, heap.runs.length]).toEqual(['aborted: maxHeapMb', 1]);
  }, 30_000);

  it('refuses scenarios that exceed the run bound or make no sense', () => {
    expect(() => resolveScenario({ name: 'x', runs: 500 })).toThrow(/bounds.maxRuns/);
    expect(() => resolveScenario({ name: 'x', runs: 0 })).toThrow(/runs/);
    expect(() => resolveScenario({ name: 'x', cadenceS: 0 })).toThrow(/cadenceS/);
    expect(() => resolveScenario({ name: 'x', duplicateFraction: 0.7, invalidFraction: 0.5 })).toThrow(/fractions/);
    expect(() => resolveScenario({ name: 'x', qualifyingFraction: 2 })).toThrow(/fractions/);
    expect(() => resolveScenario({ name: 'x', phases: [{ fromS: 0, toS: 100, ratePerS: 1 }, { fromS: 50, toS: 200, ratePerS: 1 }] })).toThrow(/phases/);
    expect(() => resolveScenario({ name: 'x', futureOptIn225: true, note: 'a fast one' })).toThrow(/note/);
  });
});

describe('reproducibility and isolation', () => {
  it('gives the same summary for the same seed and config, apart from timing', async () => {
    const input: ScenarioInput = { name: 'repeat', runs: 3, phases: [{ fromS: 0, toS: 1800, ratePerS: 12 / 1800 }], duplicateFraction: 0.2, invalidFraction: 0.2, qualifyingFraction: 0.5 };
    const a = await run(input);
    const b = await run(input);
    expectPassed(a);
    expect(withoutTiming(b)).toEqual(withoutTiming(a));
    const c = await run({ ...input, seed: 'another seed' });
    expect(c.meta.seed).toBe('another seed');
    expect(withoutTiming(c).runs).not.toEqual(withoutTiming(a).runs);
  }, 30_000);

  it('puts the clock, network and working directory back after a run', async () => {
    const before = { date: globalThis.Date, fetch: globalThis.fetch, ws: globalThis.WebSocket, cwd: process.cwd(), token: process.env.GITHUB_TOKEN };
    const s = await run({ name: 'tidy', runs: 1, phases: [{ fromS: 0, toS: 900, ratePerS: 2 / 900 }], qualifyingFraction: 1 });
    expectPassed(s);
    expect({ date: globalThis.Date, fetch: globalThis.fetch, ws: globalThis.WebSocket, cwd: process.cwd(), token: process.env.GITHUB_TOKEN }).toEqual(before);
  }, 30_000);

  it('summarizes each run in a readable line', async () => {
    const s = await run({ name: 'lines', runs: 2, phases: [{ fromS: 0, toS: 900, ratePerS: 2 / 900 }], qualifyingFraction: 1 });
    const lines = summaryLines(s);
    expect(lines[0]).toMatch(/^lines:/);
    expect(lines.filter((l) => /^ {2}run /.test(l))).toHaveLength(2);
    expect(lines.some((l) => /modeled/.test(l))).toBe(true);
  }, 30_000);
});

describe('labels and the command line', () => {
  it('samples real Argon2 and carries the sample into the summary', async () => {
    const argon = await measureArgon2(1);
    expect(argon).toMatchObject({ samples: 1, source: expect.stringMatching(/real Argon2id/) });
    expect(argon.medianMs).toBeGreaterThan(0);
    const s = await runScenario({ name: 'measured', runs: 1, phases: [{ fromS: 0, toS: 900, ratePerS: 3 / 900 }], qualifyingFraction: 1, model: { argonMs: 'measured' } }, { argon });
    expectPassed(s);
    expect(s.meta.argon).toEqual(argon);
    expect(s.runs[0].modeledRunS).toBeGreaterThanOrEqual((s.runs[0].budgetUsed * argon.medianMs) / 1000);
  }, 60_000);

  it('keeps the 30 packs/second scenario behind #225 and its opt-in flag', async () => {
    const synthetic = SCENARIOS.find((x) => x.futureOptIn225)!;
    expect(synthetic.note).toMatch(/#225/);
    expect(synthetic.phases?.[0].ratePerS).toBe(30);
    expect(selectScenarios([]).some((x) => x.futureOptIn225)).toBe(false);
    expect(selectScenarios(['--include-slow']).some((x) => x.futureOptIn225)).toBe(false);
    expect(() => selectScenarios(['--scenario', synthetic.name])).toThrow(/--include-synthetic-225/);
    expect(selectScenarios(['--scenario', synthetic.name, '--include-synthetic-225'])).toEqual([synthetic]);
    expect(() => selectScenarios(['--scenario', 'nope'])).toThrow(/Unknown scenario nope/);
    expect(selectScenarios([]).every((x) => !x.slow)).toBe(true);
    // The same shape at a tiny rate, to see the label without the minutes it costs at 30 a second.
    const s = await run({ ...synthetic, runs: 2, phases: [{ fromS: 0, toS: 180, ratePerS: 0.1 }], qualifyingFraction: 0.5 });
    expectPassed(s);
    expect(s.labels.synthetic).toMatch(/#225.*future opt-in/);
    expect(s.config.futureOptIn225).toBe(true);
    expect((await run({ name: 'plain', runs: 1 })).labels).not.toHaveProperty('synthetic');
  }, 60_000);

  it('records the runner next to the seed and config', () => {
    expect(runnerMeta()).toMatchObject({ node: process.version, platform: expect.any(String), cpus: expect.any(Number), commit: expect.any(String), command: expect.any(String) });
  });

  it('keeps every shipped default scenario valid', () => {
    for (const s of SCENARIOS) {
      const cfg = resolveScenario(s);
      expect(cfg.bounds.maxEvents).toBeLessThanOrEqual(6000);
    }
    expect(new Set(SCENARIOS.map((s) => s.name)).size).toBe(SCENARIOS.length);
  });
});
