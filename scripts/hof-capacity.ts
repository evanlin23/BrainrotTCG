/**
 * Offline capacity harness for Hall of Fame intake (#708, evidence for #242 and #225): how the real
 * `inbox()` (scripts/hall-of-fame.ts) behaves across repeated scheduled runs under bursts, backlogs
 * and outages. The inbox, its selection rules (scripts/hof-inbox.ts), the relay reader and its paging
 * all run unmodified, with the shipped caps; only the edges are replaced:
 *
 *   - GitHub and the Nostr relays are the in-memory fakes in scripts/fixtures/hof/fakes.ts. `fetch` and
 *     `WebSocket` reach only those, and anything else is refused and recorded (a check fails).
 *   - Time is a fake clock in model seconds. A run happens at an instant; nothing sleeps.
 *   - Ticket verification is STUBBED: two pre-mined tickets (one qualifying pack, one not) stand in for
 *     Argon2, so a run of 300 derivations costs milliseconds. Proof and event signatures are real.
 *   - Per-run cost in the report is MODELED: derivations x the Argon2 time (a small real sample, or an
 *     explicit input) plus request counts x the latency inputs. It is not observed production throughput.
 *
 * Every scenario parameter is an input (see `Scenario`). Correctness and resource bounds fail the run;
 * timing is report-only and kept under `timing`, apart from the reproducible rest of the summary.
 *
 *   npx tsx scripts/hof-capacity.ts --list
 *   npx tsx scripts/hof-capacity.ts [--scenario name]... [--seed text] [--argon-samples n] [--out file.json]
 *   npx tsx scripts/hof-capacity.ts --scenario synthetic-30-packs-per-second --include-synthetic-225
 *
 * It writes no real GitHub issue, dispatches nothing and sends nothing to a relay or to Pages.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { isOpenable, SETS } from '../src/content/sets/index.ts';
import {
  computeTicket, decodeProof, encodeProof, generatePack, packSeedFromTicket, publicKeyFromSecret, pullId, qualifiesForHallOfFame, scorePack, setKey, signProof, toHex, utf8,
  type SetDefinition, type TicketFn,
} from '../src/engine/index.ts';
import { HOF_KIND, HOF_RELAYS, HOF_TAG, signEvent, type NostrEvent } from '../src/game/nostrInbox.ts';
import { FakeGitHub, FakeRelays, type FakeIssue } from './fixtures/hof/fakes.ts';
import { inbox, INBOX_BUDGET, INBOX_MAX_FILED, INBOX_PAGE_SIZE, INBOX_PAGES, INBOX_SEEN_CAP, INBOX_WINDOW_S, SEEN_PATH } from './hall-of-fame.ts';
import { parseSeenCache, seenCacheText } from './hof-inbox.ts';
import { isMainModule } from './main-module.ts';

export const SCHEMA = 'hof-intake-capacity/1';
const T0_MS = Date.parse('2026-10-16T00:00:00Z');

export interface Outage {
  /** Model seconds from the start; a run is affected if it happens in [fromS, fromS + durationS). */
  fromS: number;
  durationS: number;
}

export interface Scenario {
  name: string;
  note: string;
  seed: string;
  /** Scheduled runs, one every `cadenceS` model seconds (the workflow's cron is every 15 minutes). */
  runs: number;
  cadenceS: number;
  /** Submissions arrive evenly within each phase (phases ascend and don't overlap). */
  phases: { fromS: number; toS: number; ratePerS: number }[];
  /** Of the arrivals: another event carrying an earlier qualifying pull (a second device, a resend). */
  duplicateFraction: number;
  /** Of the arrivals: a well-formed proof with a bad signature (it still spends a derivation attempt). */
  invalidFraction: number;
  /** Of the remaining arrivals: a verified pull that qualifies for the Hall of Fame. The rest are real but don't. */
  qualifyingFraction: number;
  /** Relays drop events older than this (model seconds); omitted means they keep everything. */
  relayRetentionS?: number;
  /** All relays, or the first `relaysDown` of them, refuse connections. */
  relayOutage?: Outage & { relaysDown?: number };
  /** Every GitHub request answers 500 (a run that can't list issues fails and keeps its state). */
  githubOutage?: Outage;
  /** Write requests past this many in one run answer 500: a provider rate limit, modeled as an error. */
  githubWriteLimitPerRun?: number;
  /** Write attempts (1-based, counted across the scenario) that answer 500: an interrupted filing. */
  githubFailWrites?: number[];
  /** Verified Hall of Fame issues that already exist, so issue listing needs several pages. */
  existingIssues?: number;
  /** Ids added to the seen cache after each run, dated then, as other traffic's handled events would be (past INBOX_SEEN_CAP, the oldest drop out). */
  seenFillerPerRun?: number;
  /** Modeled provider costs. `argonMs: 'measured'` takes the median of a small real Argon2 sample. */
  model: { argonMs: number | 'measured'; githubLatencyMs: number; relayLatencyMs: number; jobTimeoutS: number };
  /** The scenario stops (exit says why) instead of exceeding these. */
  bounds: { maxEvents: number; maxRuns: number; maxWallMs: number; maxHeapMb: number };
  /** Set only on #225's synthetic future opt-in: not a claim the current service supports it. */
  futureOptIn225?: boolean;
  /** Takes minutes: left out of the default list, run by name or with --include-slow. */
  slow?: boolean;
}

export type ScenarioInput = Omit<Partial<Scenario>, 'model' | 'bounds'> & { name: string; model?: Partial<Scenario['model']>; bounds?: Partial<Scenario['bounds']> };

const DEFAULTS = {
  note: '',
  seed: 'hof-capacity-1',
  runs: 8,
  cadenceS: 900,
  phases: [],
  duplicateFraction: 0,
  invalidFraction: 0,
  qualifyingFraction: 0,
  // timeout-minutes of the inbox job in .github/workflows/hall-of-fame-inbox.yml; GitHub and relay
  // latencies are round placeholders to replace with measured values (#242), not observations.
  model: { argonMs: 100, githubLatencyMs: 300, relayLatencyMs: 500, jobTimeoutS: 300 },
  bounds: { maxEvents: 6000, maxRuns: 200, maxWallMs: 120_000, maxHeapMb: 1024 },
} satisfies Omit<Scenario, 'name'>;

export const resolveScenario = (input: ScenarioInput): Scenario => {
  const s: Scenario = { ...DEFAULTS, ...input, model: { ...DEFAULTS.model, ...input.model }, bounds: { ...DEFAULTS.bounds, ...input.bounds } };
  const fail = (why: string): never => {
    throw new Error(`scenario ${s.name}: ${why}`);
  };
  const fractions = [s.duplicateFraction, s.invalidFraction, s.qualifyingFraction];
  if (fractions.some((f) => !(f >= 0 && f <= 1)) || s.duplicateFraction + s.invalidFraction > 1) fail('fractions must be within 0..1 (duplicate + invalid at most 1)');
  if (!Number.isInteger(s.runs) || s.runs < 1 || s.runs > s.bounds.maxRuns) fail(`runs must be an integer from 1 to bounds.maxRuns (${s.bounds.maxRuns})`);
  if (!(s.cadenceS > 0)) fail('cadenceS must be positive');
  let end = 0;
  for (const p of s.phases) {
    if (!(p.ratePerS >= 0) || !(p.fromS >= end) || !(p.toS >= p.fromS)) fail('phases must ascend, not overlap, and have a non-negative rate');
    end = p.toS;
  }
  if (s.futureOptIn225 && !s.note.includes('#225')) fail('futureOptIn225 scenarios must say so in their note');
  return s;
};

/** Seeded generator (mulberry32), so a seed and config reproduce every draw. */
const prng = (seed: string) => {
  const d = sha256(utf8(seed));
  let a = new DataView(d.buffer, d.byteOffset, 4).getUint32(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Two pre-mined stand-in tickets for one set: the pack from `pass` qualifies, the pack from `miss` doesn't. */
const stubTickets = (set: SetDefinition) => {
  const packs = (n: number) => {
    const ticket = sha256(utf8(`hof-capacity/stub-ticket/${n}`));
    const cards = generatePack(set, packSeedFromTicket(ticket));
    return { ticket, qualifies: qualifiesForHallOfFame(scorePack(cards.map((c) => ({ ...c, cardId: `${c.setId}/${c.cardId}` })))) };
  };
  let pass: Uint8Array | undefined;
  let miss: Uint8Array | undefined;
  for (let n = 0; !(pass && miss) && n < 100_000; n++) {
    const p = packs(n);
    if (p.qualifies) pass ??= p.ticket;
    else miss ??= p.ticket;
  }
  if (!pass || !miss) throw new Error('no stub tickets found');
  return { pass, miss };
};

/** Real Argon2id cost on this machine: a first call (it also loads the WASM) and a few more. */
export const measureArgon2 = async (samples: number) => {
  const times: number[] = [];
  for (let nonce = 0; nonce <= samples; nonce++) {
    const start = performance.now();
    await computeTicket('hof-capacity/argon-sample', new Uint8Array(32).fill(7), nonce);
    times.push(performance.now() - start);
  }
  const [first, ...rest] = times;
  const sorted = [...rest].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : first;
  return { source: 'real Argon2id (shipped TICKET_PARAMS), measured on this runner', samples: rest.length, firstCallMs: first, medianMs: median, minMs: sorted[0] ?? first, maxMs: sorted.at(-1) ?? first };
};

/** Replaces `fetch`, `WebSocket` and `Date` with the fakes and the model clock; `restore` undoes it. */
const installFakes = (github: FakeGitHub, relays: FakeRelays, clock: { ms: number }) => {
  const blocked: string[] = [];
  const names = ['fetch', 'WebSocket', 'Date'] as const;
  const saved = names.map((n) => Object.getOwnPropertyDescriptor(globalThis, n));
  const put = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const RealDate = Date;
  class ModelDate extends RealDate {
    constructor(...args: unknown[]) {
      super(...((args.length ? args : [clock.ms]) as [number]));
    }
    static now = () => clock.ms;
  }
  put('Date', ModelDate);
  put('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const res = github.handle(String(input), init);
    if (res) return res;
    blocked.push(`fetch ${init.method ?? 'GET'} ${String(input)}`);
    throw new Error(`harness is offline: ${String(input)}`);
  });
  put('WebSocket', function FakeWebSocket(url: string) {
    const socket = relays.connect(String(url));
    if (socket) return socket;
    blocked.push(`WebSocket ${url}`);
    throw new Error(`harness is offline: ${url}`);
  });
  const restore = () => names.forEach((n, i) => (saved[i] ? Object.defineProperty(globalThis, n, saved[i]) : Reflect.deleteProperty(globalThis, n)));
  return { blocked, restore };
};

type Kind = 'invalid' | 'duplicate' | 'qualifying' | 'nonqualifying';
interface Arrival {
  kind: Kind;
  proof: string;
  createdAt: number;
}

export interface RunRow {
  run: number;
  tS: number;
  outcome: 'ok' | 'failed';
  error?: string;
  arrived: number;
  /** Events on the relays after expiry, before this run read them. */
  onRelays: number;
  eventsRead: number;
  /** Relays whose read ended in an error (a run with every relay down still reports `ok`). */
  relaysFailed: number;
  /** Events the run's reader never saw because they are past the paging cap (INBOX_PAGES x INBOX_PAGE_SIZE per relay); 0 when every relay was down. */
  beyondPaging: number;
  /** In-window events on the relays that no relay could serve this run (every relay down), so none were read; not a paging effect. */
  unreadable: number;
  /** Ticket derivations plus proofs that failed verification: what the 300-attempt budget counts. */
  budgetUsed: number;
  filed: number;
  /** Events processInbox left for the next run (budget or filing cap reached, or a write failed). */
  deferred: number;
  /** Unhandled events still readable after the run, and how old the oldest is. */
  backlog: number;
  backlogQualifying: number;
  oldestBacklogAgeS: number;
  /** Cumulative events lost to expiry before being handled, by cause (never counted as delivered). */
  expiredWindow: number;
  expiredRetention: number;
  github: { reads: number; writes: number; failed: number };
  relayRequests: number;
  /** Modeled from the cost inputs; see `model`. */
  modeledRunS: number;
  modeledOverJobTimeout: boolean;
}

const stat = (xs: number[]) => (xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : { min: 0, max: 0 });

export const runScenario = async (input: ScenarioInput, opts: { argon?: Awaited<ReturnType<typeof measureArgon2>> } = {}) => {
  const cfg = resolveScenario(input);
  const argonMs = cfg.model.argonMs === 'measured' ? (opts.argon?.medianMs ?? DEFAULTS.model.argonMs) : cfg.model.argonMs;
  const set = SETS.find(isOpenable)!;
  const tickets = stubTickets(set);
  const rand = prng(cfg.seed);
  // A small pool of seeded keys: key derivation costs more than the signing, and a pull is unique by
  // (key, nonce) anyway. Fresh relay keys per event would not change what the inbox does.
  const pool = (label: string, publicOf: (sk: Uint8Array) => Uint8Array) => {
    const keys = Array.from({ length: 16 }, (_, i) => {
      const sk = sha256(utf8(`${cfg.seed}|${label}|${i}`));
      return { sk, pk: publicOf(sk) };
    });
    return (i: number) => keys[i % keys.length];
  };
  const playerKey = pool('player', publicKeyFromSecret);
  const relayKey = pool('relay', (sk) => schnorr.getPublicKey(sk));

  const clock = { ms: T0_MS };
  const events: NostrEvent[] = [];
  const relays = new FakeRelays(Object.fromEntries(HOF_RELAYS.map((r) => [r, { events }])));
  const meta = new Map<string, Arrival>(); // event id -> what the generator made it
  const expired = new Map<string, 'window' | 'retention'>();
  const handled = new Set<string>(); // every event id that has ever been in the seen cache
  const qualifyingNonces = new Set<number>();
  const qualifyingPulls = new Map<string, string[]>(); // proof -> its event ids
  const qualifyingProofs: string[] = [];

  const proofFor = (nonce: number, qualifying: boolean) => {
    const { sk, pk } = playerKey(nonce);
    if (qualifying) qualifyingNonces.add(nonce);
    return encodeProof(signProof({ setId: set.id, setVersion: set.version, publicKey: pk, nonce, name: 'Capacity Test' }, sk));
  };
  let template: ReturnType<typeof decodeProof> | undefined;
  const badTemplate = () => (template ??= decodeProof(proofFor(0, false)));
  const eventFor = (proof: string, createdAt: number, i: number): NostrEvent => {
    const { sk, pk } = relayKey(i);
    return signEvent(
      { pubkey: toHex(pk), created_at: createdAt, kind: HOF_KIND, tags: [['d', `brainrot-tcg/hof/${pullId(decodeProof(proof))}`], ['t', HOF_TAG]], content: JSON.stringify({ v: 1, proof }) },
      sk,
    );
  };
  const day = new Date(T0_MS - 86_400_000).toISOString();
  const existing = Array.from({ length: cfg.existingIssues ?? 0 }, (_, n): FakeIssue => ({ number: n + 1, title: `[Hall of Fame] existing #${n + 1}`, body: `https://example.invalid/#/pull/${proofFor(1_000_000 + n, false)}\n`, created_at: day, updated_at: day, user: { login: 'alice' }, labels: [{ name: 'hall-of-fame' }, { name: 'verified' }] }));
  const github = new FakeGitHub(existing);

  /** Cumulative arrivals by model second `t`, and the time of the j-th arrival (both from the phases). */
  const cumulative = (t: number) => cfg.phases.reduce((n, p) => n + p.ratePerS * Math.max(0, Math.min(t, p.toS) - p.fromS), 0);
  const arrivalTime = (j: number) => {
    let before = 0;
    for (const p of cfg.phases) {
      const here = p.ratePerS * (p.toS - p.fromS);
      if (j <= before + here) return p.fromS + (j - before) / p.ratePerS;
      before += here;
    }
    return Infinity;
  };
  const generate = (j: number): Arrival => {
    const createdAt = Math.floor(T0_MS / 1000 + arrivalTime(j));
    const draw = rand();
    let kind: Kind;
    let proof: string;
    if (draw < cfg.invalidFraction) {
      kind = 'invalid';
      // Well-formed but never signed for this nonce: reuse one real signature, so no signing is spent on junk.
      proof = encodeProof({ ...badTemplate(), nonce: j });
    } else if (draw < cfg.invalidFraction + cfg.duplicateFraction && qualifyingProofs.length) {
      kind = 'duplicate';
      proof = qualifyingProofs[Math.floor(rand() * qualifyingProofs.length)];
    } else {
      kind = rand() < cfg.qualifyingFraction ? 'qualifying' : 'nonqualifying';
      proof = proofFor(j, kind === 'qualifying');
    }
    return { kind, proof, createdAt };
  };

  // Run-time state the fakes' failure hook reads.
  let tS = 0;
  let writesThisRun = 0;
  let writeAttempts = 0;
  let failedThisRun = 0;
  const active = (o?: Outage) => !!o && tS >= o.fromS && tS < o.fromS + o.durationS;
  github.fail = (req) => {
    let fails = active(cfg.githubOutage);
    if (req.method !== 'GET') {
      writeAttempts++;
      writesThisRun++;
      fails ||= !!cfg.githubFailWrites?.includes(writeAttempts) || (cfg.githubWriteLimitPerRun !== undefined && writesThisRun > cfg.githubWriteLimitPerRun);
    }
    if (fails) failedThisRun++;
    return fails;
  };

  let ticketCalls = 0;
  const ticketFn: TicketFn = async (_key, _pk, nonce) => {
    ticketCalls++;
    return qualifyingNonces.has(nonce) ? tickets.pass : tickets.miss;
  };

  const home = process.cwd();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hof-capacity-'));
  const env = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GITHUB_OUTPUT: process.env.GITHUB_OUTPUT, SITE_URL: process.env.SITE_URL };
  const net = installFakes(github, relays, clock);
  const realLog = console.log;
  const realWarn = console.warn;
  let logs: string[] = [];
  const capture = (...a: unknown[]) => void logs.push(a.map(String).join(' '));

  const rows: RunRow[] = [];
  let exit: 'completed' | 'aborted: maxEvents' | 'aborted: maxWallMs' | 'aborted: maxHeapMb' = 'completed';
  let generated = 0;
  let arrivedTotal = 0;
  let heapPeak = 0;
  const wallStart = performance.now();
  const cpuStart = process.cpuUsage();
  try {
    process.chdir(dir);
    process.env.GITHUB_TOKEN = 'harness-fake-token'; // only ever reaches the fake
    delete process.env.GITHUB_OUTPUT;
    delete process.env.SITE_URL;
    console.log = capture;
    console.warn = capture;
    for (let run = 0; run < cfg.runs; run++) {
      tS = (run + 1) * cfg.cadenceS;
      clock.ms = T0_MS + tS * 1000;
      const nowS = Math.floor(clock.ms / 1000);

      const target = Math.floor(cumulative(tS) + 1e-9);
      if (arrivedTotal + (target - generated) > cfg.bounds.maxEvents) {
        exit = 'aborted: maxEvents';
        break;
      }
      const arrived = target - generated;
      for (; generated < target; generated++) {
        const a = generate(generated + 1);
        const e = eventFor(a.proof, a.createdAt, generated + 1);
        events.push(e);
        meta.set(e.id, a);
        if (a.kind === 'qualifying') {
          qualifyingPulls.set(a.proof, [e.id]);
          qualifyingProofs.push(a.proof);
        }
        else if (a.kind === 'duplicate') qualifyingPulls.get(a.proof)!.push(e.id);
      }
      arrivedTotal += arrived;

      // Expiry before this run reads: relay retention, then the inbox's own read window.
      if (cfg.relayRetentionS !== undefined) {
        const kept = events.filter((e) => e.created_at >= nowS - cfg.relayRetentionS!);
        for (const e of events) if (!handled.has(e.id) && !kept.includes(e)) expired.set(e.id, 'retention');
        events.splice(0, events.length, ...kept);
      }
      for (const e of events) if (e.created_at < nowS - INBOX_WINDOW_S && !handled.has(e.id) && !expired.has(e.id)) expired.set(e.id, 'window');
      const down = active(cfg.relayOutage) ? (cfg.relayOutage!.relaysDown ?? HOF_RELAYS.length) : 0;
      HOF_RELAYS.forEach((r, i) => (relays.relays[r].down = i < down));

      const since = nowS - INBOX_WINDOW_S;
      const onRelays = events.filter((e) => e.created_at >= since).length;
      const before = { gh: github.requests.length, relay: relays.requests.length, tickets: ticketCalls };
      writesThisRun = 0;
      failedThisRun = 0;
      logs = [];
      let error: string | undefined;
      try {
        await inbox(ticketFn);
      } catch (e) {
        error = (e instanceof Error ? e.message : String(e)).slice(0, 120);
      }
      const requests = github.requests.slice(before.gh);
      const readSeen = () => (existsSync(SEEN_PATH) ? parseSeenCache(readFileSync(SEEN_PATH, 'utf8'), nowS) : new Map<string, number>());
      for (const id of readSeen().keys()) handled.add(id);
      if (cfg.seenFillerPerRun) {
        // Other traffic's events, handled as they arrived (now), kept as the inbox keeps its own.
        const cache = readSeen();
        for (let i = 0; i < cfg.seenFillerPerRun; i++) cache.set(`filler-${run}-${i}`, nowS);
        writeFileSync(SEEN_PATH, seenCacheText(cache.keys(), cache, nowS - INBOX_WINDOW_S, nowS, INBOX_SEEN_CAP));
      }
      const seen = new Set(readSeen().keys());

      const unhandled = events.filter((e) => !seen.has(e.id) && !expired.has(e.id));
      const read = Number(/^(\d+) events read, /.exec(logs.find((l) => / events read, /.test(l)) ?? '')?.[1] ?? 0);
      const filedNow = logs.filter((l) => /^#\d+: .* from Nostr event /.test(l)).length;
      const tickets = ticketCalls - before.tickets;
      const rejected = logs.filter((l) => / didn't verify \(/.test(l)).length;
      const reads = requests.filter((r) => r.method === 'GET').length;
      const relayRequests = relays.requests.length - before.relay;
      const modeledRunS = (tickets * argonMs + (requests.length * cfg.model.githubLatencyMs) + Math.ceil(relayRequests / HOF_RELAYS.length) * cfg.model.relayLatencyMs) / 1000;
      const relaysFailed = logs.filter((l) => /^wss:\/\/\S+: \d+ events \(/.test(l)).length;
      const allRelaysDown = relaysFailed === HOF_RELAYS.length;
      // A run that failed for another reason may have read events before it stopped; one that
      // failed because every relay was down read none.
      const unread = error && !allRelaysDown ? 0 : Math.max(0, onRelays - read);
      const oldest = unhandled.length ? Math.min(...unhandled.map((e) => e.created_at)) : nowS;
      rows.push({
        run: run + 1, tS, outcome: error ? 'failed' : 'ok', ...(error ? { error } : {}), arrived, onRelays, eventsRead: read, relaysFailed, beyondPaging: allRelaysDown ? 0 : unread, unreadable: allRelaysDown ? unread : 0,
        budgetUsed: tickets + rejected, filed: filedNow, deferred: Number(/^(\d+) events left/.exec(logs.find((l) => / events left for the next run/.test(l)) ?? '')?.[1] ?? 0),
        backlog: unhandled.length, backlogQualifying: unhandled.filter((e) => ['qualifying', 'duplicate'].includes(meta.get(e.id)!.kind)).length, oldestBacklogAgeS: nowS - oldest,
        expiredWindow: [...expired.values()].filter((v) => v === 'window').length, expiredRetention: [...expired.values()].filter((v) => v === 'retention').length,
        github: { reads, writes: requests.length - reads, failed: failedThisRun }, relayRequests, modeledRunS, modeledOverJobTimeout: modeledRunS > cfg.model.jobTimeoutS,
      });
      heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed / 2 ** 20);
      if (performance.now() - wallStart > cfg.bounds.maxWallMs) exit = 'aborted: maxWallMs';
      else if (heapPeak > cfg.bounds.maxHeapMb) exit = 'aborted: maxHeapMb';
      if (exit !== 'completed') break;
    }
  } finally {
    console.log = realLog;
    console.warn = realWarn;
    net.restore();
    process.chdir(home);
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  // Outcomes. A pull is delivered only when its issue carries a verified or daily label.
  const bots = github.botIssues();
  const proofsOf = (list: FakeIssue[]) => list.map((i) => /#\/pull\/([A-Za-z0-9_-]+)/.exec(i.body ?? '')?.[1] ?? '');
  const delivered = new Set(proofsOf(bots.filter((i) => i.labels.some((l) => l.name === 'verified' || l.name === 'daily'))));
  const allBotProofs = proofsOf(bots);
  const pending = (id: string) => !handled.has(id) && !expired.has(id);
  const pulls = { qualifying: qualifyingPulls.size, delivered: 0, pending: 0, expiredBeforeHandled: 0, lost: 0 };
  for (const [proof, ids] of qualifyingPulls) {
    if (delivered.has(proof)) pulls.delivered++;
    else if (ids.some(pending)) pulls.pending++;
    else if (ids.some((id) => handled.has(id))) pulls.lost++;
    else pulls.expiredBeforeHandled++;
  }
  const kinds = (['qualifying', 'duplicate', 'invalid', 'nonqualifying'] as const).map((k) => {
    const ids = [...meta].filter(([, a]) => a.kind === k).map(([id]) => id);
    return [k, { arrived: ids.length, handled: ids.filter((id) => handled.has(id)).length, backlog: ids.filter(pending).length, expiredWindow: ids.filter((id) => expired.get(id) === 'window').length, expiredRetention: ids.filter((id) => expired.get(id) === 'retention').length }] as const;
  });
  const last = rows.at(-1);
  const lastArrivalRun = [...rows].reverse().find((r) => r.arrived > 0)?.run ?? 0;
  const drainedAt = rows.find((r) => r.run > lastArrivalRun && r.backlog === 0 && r.outcome === 'ok')?.run ?? (lastArrivalRun > 0 && rows.some((r) => r.run === lastArrivalRun && r.backlog === 0) ? lastArrivalRun : null);

  const checks = [
    ['no request left the fakes', net.blocked.length === 0, net.blocked.slice(0, 3).join('; ')],
    [`each run spent at most ${INBOX_BUDGET} derivation attempts`, rows.every((r) => r.budgetUsed <= INBOX_BUDGET), `max ${stat(rows.map((r) => r.budgetUsed)).max}`],
    [`each run filed at most ${INBOX_MAX_FILED} entries`, rows.every((r) => r.filed <= INBOX_MAX_FILED), `max ${stat(rows.map((r) => r.filed)).max}`],
    ['no pull filed twice', new Set(allBotProofs).size === allBotProofs.length, `${allBotProofs.length - new Set(allBotProofs).size} repeated`],
    ['no qualifying pull handled yet not filed', pulls.lost === 0, `${pulls.lost} lost`],
    ['stayed within resource bounds', exit === 'completed', exit],
  ].map(([name, ok, detail]) => ({ name: name as string, ok: ok as boolean, detail: detail as string }));

  const cpu = process.cpuUsage(cpuStart);
  const cpuUsed = cpu.user + cpu.system;
  return {
    schema: SCHEMA,
    labels: {
      verification: 'stubbed: two pre-mined stand-in tickets replace Argon2; proof and event signatures are real',
      time: 'fake clock in model seconds; nothing slept, so no wall-clock throughput is implied',
      providers: 'in-memory GitHub and relay fakes; latencies and limits are inputs, not observations',
      limits: 'not exercised: the published list is assumed to be a 404, so the floor and joinRefusal paths do not run; event and proof keys come from 16-key pools',
      capacity: 'modeledRunS is derivations x argonMs + requests x latency inputs; not observed production throughput',
      ...(cfg.futureOptIn225 ? { synthetic: "#225's synthetic future opt-in scenario, not a claim the current service supports this rate" } : {}),
    },
    meta: { seed: cfg.seed, argon: opts.argon ?? { source: cfg.model.argonMs === 'measured' ? 'measured-missing (no sample passed; the default argonMs was used)' : 'input', medianMs: argonMs }, set: setKey(set), shipped: { budget: INBOX_BUDGET, maxFiled: INBOX_MAX_FILED, pageSize: INBOX_PAGE_SIZE, pages: INBOX_PAGES, windowS: INBOX_WINDOW_S, seenCap: INBOX_SEEN_CAP } },
    config: cfg,
    runs: rows,
    totals: {
      arrived: arrivedTotal,
      kinds: Object.fromEntries(kinds),
      pulls,
      githubReads: rows.reduce((n, r) => n + r.github.reads, 0),
      githubWrites: rows.reduce((n, r) => n + r.github.writes, 0),
      githubFailed: rows.reduce((n, r) => n + r.github.failed, 0),
      relayRequests: rows.reduce((n, r) => n + r.relayRequests, 0),
      derivations: ticketCalls,
      peakBacklog: Math.max(0, ...rows.map((r) => r.backlog)),
      peakOldestBacklogAgeS: Math.max(0, ...rows.map((r) => r.oldestBacklogAgeS)),
      backlogAtEnd: last?.backlog ?? 0,
      failedRuns: rows.filter((r) => r.outcome === 'failed').length,
    },
    drain: { lastArrivalRun, backlogZeroAtRun: drainedAt, runsToDrain: drainedAt === null ? null : Math.max(0, drainedAt - lastArrivalRun) },
    exit,
    checks,
    timing: { note: 'report-only: this runner, this moment', wallMs: Math.round(performance.now() - wallStart), cpuMs: Math.round(cpuUsed / 1000), heapPeakMb: Math.round(heapPeak) },
  };
};
export type Summary = Awaited<ReturnType<typeof runScenario>>;

/** The command-line scenarios. Each is small enough to finish in seconds; `futureOptIn225` ones need a flag. */
export const SCENARIOS: ScenarioInput[] = [
  { name: 'steady-trickle', note: 'a quiet three hours: a few submissions an hour, every run keeps up', runs: 12, phases: [{ fromS: 0, toS: 10_800, ratePerS: 0.01 }], duplicateFraction: 0.2, invalidFraction: 0.1, qualifyingFraction: 0.3 },
  { name: 'burst-drain', note: 'one qualifying burst: filing is capped at 20 a run, so the backlog drains over several runs', runs: 9, phases: [{ fromS: 0, toS: 600, ratePerS: 0.25 }], duplicateFraction: 0.2, qualifyingFraction: 1 },
  { name: 'overload-junk', note: 'more invalid and non-qualifying events than the 300-attempt budget covers: the backlog waits for later runs', runs: 5, phases: [{ fromS: 0, toS: 1000, ratePerS: 0.4 }], invalidFraction: 0.4, qualifyingFraction: 0.05 },
  { name: 'github-outage', note: 'GitHub down for an hour then back: runs fail without losing state, then drain', runs: 10, phases: [{ fromS: 0, toS: 3600, ratePerS: 0.03 }], qualifyingFraction: 0.5, githubOutage: { fromS: 1800, durationS: 3600 } },
  { name: 'relay-outage-window-expiry', note: 'every relay down for 8 days with daily runs: the 7-day read window expires events nobody handled, then new ones are delivered', runs: 14, cadenceS: 86_400, phases: [{ fromS: 0, toS: 86_400, ratePerS: 0.001 }, { fromS: 777_600, toS: 864_000, ratePerS: 0.0005 }], qualifyingFraction: 1, relayOutage: { fromS: 86_400, durationS: 8 * 86_400 } },
  { name: 'relay-retention-expiry', note: 'relays keep events one hour but runs are two hours apart: some are gone before any run reads them', runs: 8, cadenceS: 7200, phases: [{ fromS: 0, toS: 28_800, ratePerS: 0.005 }], qualifyingFraction: 1, relayRetentionS: 3600 },
  { name: 'interrupted-filing', note: 'filing writes fail part-way (250 issues already exist, so listing takes 3 pages): the next run finishes the same issues without filing twice', runs: 6, phases: [{ fromS: 0, toS: 900, ratePerS: 0.02 }], qualifyingFraction: 1, githubFailWrites: [2, 3, 7], existingIssues: 250 },
  { name: 'write-limit', note: 'GitHub answers 500 to writes past 30 a run (a modeled provider limit): filing is slower than the 20-a-run cap', runs: 8, phases: [{ fromS: 0, toS: 900, ratePerS: 0.1 }], qualifyingFraction: 1, githubWriteLimitPerRun: 30 },
  { name: 'seen-cache-overflow', note: 'other traffic adds 20,000 handled ids a run: the cache keeps every id inside the read window, so handled events are not derived again', runs: 4, phases: [{ fromS: 0, toS: 900, ratePerS: 0.05 }], invalidFraction: 0.5, qualifyingFraction: 0.3, seenFillerPerRun: 20_000 },
  { name: 'paging-cap', slow: true, note: 'about 5,200 events on the relays, more than 50 pages x 100 can reach: the oldest are not read (slow: about two minutes)', runs: 2, cadenceS: 2000, phases: [{ fromS: 0, toS: 2000, ratePerS: 2.6 }] },
  { name: 'synthetic-30-packs-per-second', slow: true, note: "#225's synthetic future opt-in: every generated pack submitted, 30 a second for 3 minutes, about 1 in 70 qualifying (slow: about two minutes)", futureOptIn225: true, runs: 2, cadenceS: 180, phases: [{ fromS: 0, toS: 180, ratePerS: 30 }], qualifyingFraction: 1 / 70 },
];

/** Where this code came from and what ran it, so a summary can be reproduced. */
export const runnerMeta = () => {
  const git = (...args: string[]) => {
    try {
      return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return 'unknown';
    }
  };
  return { commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain') !== '', node: process.version, platform: `${process.platform}-${process.arch}`, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? 'unknown', totalMemMb: Math.round(os.totalmem() / 2 ** 20), command: process.argv.slice(1).join(' ') };
};

/** One readable line per run, then the checks. */
export const summaryLines = (s: Summary): string[] => [
  `${s.config.name}: ${s.config.note}`,
  ...s.runs.map((r) => `  run ${String(r.run).padStart(2)} t=${r.tS}s ${r.outcome}${r.error ? ` (${r.error})` : ''} arrived ${r.arrived}, read ${r.eventsRead}/${r.onRelays} (past paging ${r.beyondPaging}, unreadable ${r.unreadable}), budget ${r.budgetUsed}, filed ${r.filed}, backlog ${r.backlog} (oldest ${r.oldestBacklogAgeS}s), relays down ${r.relaysFailed}, expired ${r.expiredWindow}w/${r.expiredRetention}r, gh ${r.github.reads}r/${r.github.writes}w, modeled ${r.modeledRunS.toFixed(1)}s`),
  `  pulls ${JSON.stringify(s.totals.pulls)}; drain ${JSON.stringify(s.drain)}; exit ${s.exit}`,
  ...s.checks.filter((c) => !c.ok).map((c) => `  CHECK FAILED: ${c.name} (${c.detail})`),
];

const valuesOf = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));

/** Which scenarios the command line asks for; throws on an unknown name or on #225's opt-in without its flag. */
export const selectScenarios = (args: string[]): ScenarioInput[] => {
  const wanted = valuesOf(args, '--scenario');
  const unknown = wanted.filter((n) => !SCENARIOS.some((s) => s.name === n));
  if (unknown.length) throw new Error(`Unknown scenario ${unknown.join(', ')}; see --list`);
  const chosen = SCENARIOS.filter((s) => (wanted.length ? wanted.includes(s.name) : !s.futureOptIn225 && (!s.slow || args.includes('--include-slow'))));
  if (chosen.some((s) => s.futureOptIn225) && !args.includes('--include-synthetic-225')) throw new Error("The 30 packs/second scenario is #225's synthetic future opt-in; add --include-synthetic-225");
  return chosen;
};

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const s of SCENARIOS) console.log(`${s.name}${s.futureOptIn225 ? ' (needs --include-synthetic-225)' : ''}${s.slow ? ' (slow)' : ''}: ${s.note}`);
    process.exit(0);
  }
  let chosen: ScenarioInput[];
  try {
    chosen = selectScenarios(args);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  const seed = valuesOf(args, '--seed')[0];
  const argon = await measureArgon2(Number(valuesOf(args, '--argon-samples')[0] ?? 3));
  const summaries: Summary[] = [];
  for (const s of chosen) {
    const summary = await runScenario({ ...s, model: { ...s.model, argonMs: 'measured' }, ...(seed ? { seed } : {}) }, { argon });
    summaries.push(summary);
    for (const line of summaryLines(summary)) console.log(line);
  }
  const out = valuesOf(args, '--out')[0];
  if (out) writeFileSync(out, JSON.stringify({ schema: SCHEMA, runner: runnerMeta(), summaries }, null, 1) + '\n');
  const failed = summaries.flatMap((s) => s.checks.filter((c) => !c.ok).map((c) => `${s.config.name}: ${c.name}`));
  console.log(failed.length ? `FAILED: ${failed.join('; ')}` : `${summaries.length} scenarios, all deterministic checks passed${out ? `; raw summaries in ${out}` : ''}`);
  process.exit(failed.length ? 1 : 0);
}
